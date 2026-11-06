#!/usr/bin/env python3
"""Analyze alpha and write JSON; PNGs are only copied byte-for-byte. Requires Pillow."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT.parent / 'character-skill-art'
CHECK_SOURCE = ROOT / 'assets/fighters/skills'
DESTINATION = ROOT / 'assets/fighters/skills.json'
# Sole centers in original sheet coordinates, relative to each logical tile.
# These are anatomical anchors, deliberately independent of tail/wing/book bounds.
FEET = {
    'deepseek': [[158, 155, 107, 158], [158, 185, 143, 164],
                 [148, 132, 151, 157], [165, 164, 148, 161]],
    'claude': [[171, 170, 168, 173], [173, 173, 167, 174],
               [175, 171, 171, 173], [172, 173, 173, 176]],
    'chatgpt': [[162, 165, 166, 169], [164, 166, 191, 166],
                [195, 193, 207, 207], [164, 162, 180, 181]],
}
# Standing reference pose only. Crouched/leaning poses retain the same scale.
STANDING_TOP = {'deepseek': 48, 'claude': 8, 'chatgpt': 9}


def divider(alpha, axis, target, start=0, end=None):
    """Find a real gutter, preserving antialiasing above the 1..8 noise floor."""
    width, height = alpha.size
    end = end or (height if axis == 'x' else width)
    pixels = alpha.load()
    for threshold in (8, 16, 24):
        candidates = []
        for position in range(target-40, target+41):
            maximum = max(pixels[position, t] if axis == 'x' else pixels[t, position]
                          for t in range(start, end))
            if maximum <= threshold:
                candidates.append((abs(position-target), position, maximum))
        if candidates:
            _, position, maximum = min(candidates)
            return position, maximum
    raise ValueError(f'No safe alpha gutter: {axis}={target}')


def source_image(source, character, kind):
    """Accept the repository's flat PNG directory or the original art layout."""
    filename = f'{character}-{kind}.png'
    flat = source / filename
    return flat if flat.is_file() else source / kind / filename


def sheet(source, character, kind, base):
    relative = f'assets/fighters/skills/{character}-{kind}.png'
    path = source_image(source, character, kind)
    with Image.open(path) as image:
        assert image.mode == 'RGBA' and image.size == (1254, 1254), path
        alpha = image.getchannel('A')
    width, height = alpha.size
    horizontal = [divider(alpha, 'y', q) for q in (314, 627, 940)]
    ys = [0, *(p for p, _ in horizontal), height]
    frames, bands = [], []
    for row in range(4):
        # Per-row gutters retain faint Claude halos that a global x=618 cut loses.
        vertical = [divider(alpha, 'x', q, ys[row], ys[row+1]) for q in (314, 627, 940)]
        xs = [0, *(p for p, _ in vertical), width]
        bands.append({'y': ys[row:row+2], 'x': xs,
                      'gutterAlpha': [maximum for _, maximum in vertical]})
        for column in range(4):
            left, right = xs[column:column+2]
            top, bottom = ys[row:row+2]
            # Pillow reads only: no alpha cleanup or resampling is written to PNG.
            tile = alpha.crop((left, top, right, bottom))
            silhouette = tile.point(lambda a: 255 if a > 8 else 0).getbbox()
            assert silhouette, (character, kind, row, column)
            x0, y0, x1, y1 = silhouette
            x0 += left; x1 += left; y0 += top; y1 += top
            rect = [max(left, x0-1), max(top, y0-1),
                    min(right, x1+1), min(bottom, y1+1)]
            rect[2] -= rect[0]; rect[3] -= rect[1]
            if kind == 'actions':
                # The anchor x is between the soles, and may itself be empty.
                # Read both feet, rather than a narrow band through that gap.
                center = round(column * width/4) + FEET[character][row][column]
                opaque = tile.point(lambda a: 255 if a >= 200 else 0).getbbox()
                sole = top + opaque[3]
                anchor = [center, sole]
            else:
                anchor = [(column+.5)*width/4, (row+.5)*height/4]
            frames.append({'name': f'{character}-{kind}-{row}-{column}',
                           'row': row, 'column': column, 'rect': rect,
                           'origin': [anchor[0]-rect[0], anchor[1]-rect[1]],
                           'anchor': anchor, 'silhouette': [x0, y0, x1, y1]})
    idle = base['frames']['idle0']
    reference_height = idle['origin'][1] * base['scale']
    standing_height = frames[0]['anchor'][1] - STANDING_TOP[character]
    scale = reference_height / standing_height if kind == 'actions' else 1
    return {'image': relative, 'width': width, 'height': height,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'scale': scale, 'referenceHeight': reference_height,
            'standingHeight': standing_height, 'cellSize': [width/4, height/4],
            'horizontalGutterAlpha': [maximum for _, maximum in horizontal],
            'bands': bands, 'frames': frames}


def build(source):
    base = json.loads((ROOT / 'assets/fighters/ai.json').read_text())
    return {'version': 1, 'noiseAlphaMax': 8,
            'cropPolicy': 'alpha>8 bounds inside measured gutters; gutters <=24; no PNG edits',
            'characters': {character: {kind: sheet(source, character, kind, base[character])
                                       for kind in ('actions', 'effects')} for character in FEET}}


def audit(registry, source):
    count = 0
    weak_seams = []
    for character, sheets in registry['characters'].items():
        for kind, meta in sheets.items():
            destination = ROOT / meta['image']
            png = destination.read_bytes()
            assert hashlib.sha256(png).hexdigest() == meta['sha256'], f'PNG hash mismatch: {destination}'
            assert png == source_image(source, character, kind).read_bytes(), destination
            with Image.open(destination) as image:
                alpha = image.getchannel('A')
                pixels = alpha.load()
                for frame in meta['frames']:
                    row, column = frame['row'], frame['column']
                    band = meta['bands'][row]
                    left, right = band['x'][column:column+2]
                    top, bottom = band['y']
                    x, y, w, h = frame['rect']
                    assert left <= x < x+w <= right and top <= y < y+h <= bottom
                    # Entire assigned alpha silhouette is in the crop, and every
                    # pixel in it belongs to this cell (including detached pages).
                    bounds = alpha.crop((left, top, right, bottom)).point(
                        lambda a: 255 if a > 8 else 0).getbbox()
                    assert frame['silhouette'] == [bounds[0]+left, bounds[1]+top,
                                                   bounds[2]+left, bounds[3]+top]
                    assert x <= bounds[0]+left and y <= bounds[1]+top
                    assert x+w >= bounds[2]+left and y+h >= bounds[3]+top
                    if kind == 'actions':
                        ax, ay = frame['anchor']
                        assert any(pixels[xx, ay-1] >= 200 for xx in range(left, right))
                    count += 1
                for row, band in enumerate(meta['bands']):
                    for x, maximum in zip(band['x'][1:-1], band['gutterAlpha']):
                        assert maximum <= 24
                        if maximum > 8:
                            weak_seams.append({'image': destination.name, 'row': row,
                                               'x': x, 'maxAlpha': maximum})
    assert count == 96
    return {'tiles': count, 'pngBytesUnchanged': True, 'weakHaloSeams': weak_seams,
            'geometry': 'all alpha>8 in assigned measured cells retained; no alpha>24 split'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path,
                        help='Flat PNG directory or original actions/effects directory; '
                             'defaults to repository PNGs for --check, original art for rebuild')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    source = args.source if args.source is not None else CHECK_SOURCE if args.check else DEFAULT_SOURCE
    if args.check:
        registry = json.loads(DESTINATION.read_text())
        # Audit against the committed hashes before recomputing metadata, so
        # check mode never silently accepts a changed PNG as a new baseline.
        report = audit(registry, source)
        assert build(source) == registry, 'Metadata needs rebuilding'
    else:
        registry = build(source)
        (ROOT / 'assets/fighters/skills').mkdir(parents=True, exist_ok=True)
        for character, sheets in registry['characters'].items():
            for kind, meta in sheets.items():
                original, destination = source_image(source, character, kind), ROOT / meta['image']
                if original.resolve() != destination.resolve():
                    shutil.copyfile(original, destination)
        DESTINATION.write_text(json.dumps(registry, ensure_ascii=False, indent=2)+'\n')
        report = audit(registry, source)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
