#!/usr/bin/env python3
"""Rebuild crops without touching PNGs. Requires Pillow. Run with --check to audit."""
import argparse
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
# Original sheet-space anchors are independent of each new crop's top-left.
LAYOUTS = {
    'deepseek': ([0, 215, 421, 626, 831, 992, 1186, 1362, 1536],
                 [207, 413, 618, 822, 983, 1182, 1357, 1530], 1523),
    'claude': ([0, 239, 475, 709, 955, 1177, 1415, 1649, 1881],
               [223, 458, 693, 928, 1159, 1398, 1632, 1867], 1860),
    'chatgpt': ([0, 237, 471, 706, 947, 1162, 1409, 1640, 1881],
                [224, 456, 691, 927, 1147, 1388, 1625, 1862], 1860),
}
POSES = {
    **{f'idle{i}': (0, i) for i in range(4)},
    **{f'walk{i}': (1, i) for i in range(6)},
    **{f'back{i}': (1, 5-i) for i in range(6)},
    **{f'punch{i}': (2, c) for i, c in enumerate([1, 3, 4, 3])},
    **{f'kick{i}': (3, i) for i in range(4)},
    **{f'low{i}': (4, i) for i in range(4)},
    'recover0': (4, 4), 'recover1': (4, 5),
    **{f'air{i}': (5, i) for i in range(4)},
    **{f'jump{i}': (5, c) for i, c in enumerate([0, 1, 5, 2])},
    **{f'hit{i}': (6, c) for i, c in enumerate([0, 2, 3, 4])},
    **{f'ko{i}': (7, c) for i, c in enumerate([0, 1, 2, 4])},
    'block0': (6, 0), 'block1': (6, 1),
    **{f'fire{i}': (2, c) for i, c in enumerate([1, 3, 4, 3])},
    'victory0': (7, 5),
}


def bounds(pixels, width):
    xs = [p % width for p in pixels]
    ys = [p // width for p in pixels]
    return [min(xs), min(ys), max(xs)+1, max(ys)+1]


def inside(p, box, width):
    return box[0] <= p % width < box[2] and box[1] <= p // width < box[3]


def components(alpha, width, height):
    """Alpha >=16 keeps antialiasing attached but rejects the faint background."""
    seen = bytearray(len(alpha))
    result = []
    for start, opacity in enumerate(alpha):
        if opacity < 16 or seen[start]:
            continue
        seen[start] = 1
        pixels = [start]
        for p in pixels:
            x, y = p % width, p // width
            for yy in range(max(0, y-1), min(height, y+2)):
                for xx in range(max(0, x-1), min(width, x+2)):
                    q = yy*width + xx
                    if not seen[q] and alpha[q] >= 16:
                        seen[q] = 1
                        pixels.append(q)
        core = [p for p in pixels if alpha[p] >= 96]
        if len(core) > 700:
            result.append({'pixels': pixels, 'core': core, 'bbox': bounds(pixels, width)})
    return result


def baseline(character, width):
    bands, anchors_y, ko_y = LAYOUTS[character]
    result = {}
    for name, (row, col) in POSES.items():
        if character == 'deepseek' and row == 1:
            col = ([0, 1, 2, 3, 4, 0] if name.startswith('walk') else [4, 3, 2, 1, 0, 0])[int(name[-1])]
        columns = 5 if character == 'deepseek' and row < 2 else 6
        cuts = [round(i*width/columns) for i in range(columns+1)]
        left, right = cuts[col:col+2]
        anchor_x = (round((right-left)*.57) if row == 0 else 135 if row == 1 else round((right-left)*.6)) if character == 'deepseek' else 74
        result[name] = ([left, bands[row], right, bands[row+1]],
                        [left+anchor_x, ko_y if name == 'ko3' else anchors_y[row]], (row, col))
    return result


def outline(box, exclusions):
    """Cut only edge notches, leaving a single source-coordinate polygon."""
    left, top, right, bottom = box
    points = [[left, top], [right, top]]
    for x0, y0, x1, y1 in sorted((e for e in exclusions if e[2] == right), key=lambda e: e[1]):
        points.extend([[right, y0], [x0, y0], [x0, y1], [right, y1]])
    points.extend([[right, bottom], [left, bottom]])
    for x0, y0, x1, y1 in sorted((e for e in exclusions if e[0] == left), key=lambda e: -e[3]):
        points.extend([[left, y1], [x1, y1], [x1, y0], [left, y0]])
    return points


def rebuild(character, meta):
    with Image.open(ROOT / meta['image']) as image:
        width, height = image.size
        alpha = image.getchannel('A').tobytes()
    poses = components(alpha, width, height)
    assert len(poses) == (46 if character == 'deepseek' else 48), (character, 'unexpected pose count')
    bands = LAYOUTS[character][0]
    rows = [[] for _ in range(8)]
    for pose in poses:
        b = pose['bbox']
        row = max(range(8), key=lambda i: max(0, min(b[3], bands[i+1])-max(b[1], bands[i])))
        rows[row].append(pose)
    for row, group in enumerate(rows):
        group.sort(key=lambda p: p['bbox'][0])
        assert len(group) == (5 if character == 'deepseek' and row < 2 else 6), (character, row)
    assert set(meta['frames']) == set(POSES), (character, 'unexpected aliases')
    frames = {}
    for name, (old, anchor, (row, col)) in baseline(character, width).items():
        intended = rows[row][col]
        matched = max(poses, key=lambda c: sum(inside(p, old, width) for p in c['core']))
        assert matched is intended, (character, name, 'ambiguous pose mapping')
        b = intended['bbox']
        crop = [max(0, b[0]-2), max(0, b[1]-2), min(width, b[2]+2), min(height, b[3]+2)]
        exclusions = []
        for foreign in poses:
            if foreign is intended:
                continue
            f = foreign['bbox']
            if f[2] <= crop[0] or f[0] >= crop[2] or f[3] <= crop[1] or f[1] >= crop[3]:
                continue
            pixels = [p for p in foreign['pixels'] if inside(p, crop, width)]
            if not pixels:
                continue
            f = bounds(pixels, width)
            cut = [max(crop[0], f[0]-2), max(crop[1], f[1]-2), min(crop[2], f[2]+2), min(crop[3], f[3]+2)]
            assert (cut[0] == crop[0]) != (cut[2] == crop[2]), (character, name, 'not an edge notch')
            assert not any(inside(p, cut, width) for p in intended['pixels']), (character, name, 'clip cuts own silhouette')
            assert not any(max(cut[1], e[1]) < min(cut[3], e[3]) and max(cut[0], e[0]) < min(cut[2], e[2]) for e in exclusions)
            exclusions.append(cut)
        frame = {'rect': [crop[0], crop[1], crop[2]-crop[0], crop[3]-crop[1]],
                 'origin': [anchor[0]-crop[0], anchor[1]-crop[1]]}
        if exclusions:
            frame['clip'] = outline(crop, exclusions)
        frames[name] = frame
    return {**meta, 'frames': frames}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if checked-in metadata differs from source analysis')
    args = parser.parse_args()
    path = ROOT / 'assets/fighters/ai.json'
    current = json.loads(path.read_text())
    rebuilt = {character: rebuild(character, meta) for character, meta in current.items()}
    if args.check:
        if rebuilt != current:
            raise SystemExit('FAIL sprite metadata differs; run python3 tools/rebuild-sprite-frames.py')
    else:
        path.write_text(json.dumps(rebuilt, indent=2)+'\n')
    for character, meta in rebuilt.items():
        print(f"PASS {character}: {len(meta['frames'])} aliases, {sum('clip' in f for f in meta['frames'].values())} edge clips, original anchors")


if __name__ == '__main__':
    main()
