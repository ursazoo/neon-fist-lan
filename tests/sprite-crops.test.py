"""Run with python3 tests/sprite-crops.test.py. Requires Pillow."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sprite_crops', ROOT / 'tools/rebuild-sprite-frames.py')
crops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crops)


def visible(pixel, frame, width):
    x, y = pixel % width + .5, pixel // width + .5
    left, top, w, h = frame['rect']
    if not (left <= x < left+w and top <= y < top+h):
        return False
    polygon = frame.get('clip')
    if polygon is None:
        return True
    inside = False
    for a, b in zip(polygon, polygon[1:]+polygon[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


class SpriteCrops(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = json.loads((ROOT / 'assets/fighters/ai.json').read_text())
        cls.sources = {}
        for character, meta in cls.registry.items():
            with Image.open(ROOT / meta['image']) as image:
                width, height = image.size
                poses = crops.components(image.getchannel('A').tobytes(), width, height)
            cls.sources[character] = (width, poses)

    def test_approved_anchors_and_png_bytes_are_unchanged(self):
        anchors = {c: {n: [f['rect'][i]+f['origin'][i] for i in range(2)]
                       for n, f in m['frames'].items()} for c, m in self.registry.items()}
        digest = hashlib.sha256(json.dumps(anchors, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(digest, '2cf809e6cf2fed7e0fc88712ad544bd470b889bcb743c2365f24eeee5b3fed68')
        pngs = {
            'deepseek': '59c19b93289ba8ebae8822540301b21bd96d6fd37b8922fa426a344d9071ef44',
            'claude': '53b05d9ebc79c89013becb3b86432297c9927659deea143ef121af7ee71f5e3f',
            'chatgpt': 'f63cc454addf99f7b937ee6368c6fea375a2a025787378eec990f4a1fa0bc603',
        }
        for character, digest in pngs.items():
            self.assertEqual(hashlib.sha256((ROOT / self.registry[character]['image']).read_bytes()).hexdigest(), digest)

    def test_all_159_aliases_keep_whole_poses_and_exclude_foreign_pixels(self):
        total = 0
        for character, meta in self.registry.items():
            width, poses = self.sources[character]
            previous_groups, current_groups = {}, {}
            for name, (old, _, _) in crops.baseline(character, width).items():
                frame = meta['frames'][name]
                intended = max(poses, key=lambda p: sum(crops.inside(q, old, width) for q in p['core']))
                self.assertTrue(all(visible(q, frame, width) for q in intended['pixels']), (character, name, 'missing own alpha >=16'))
                x, y, w, h = frame['rect']
                for foreign in poses:
                    if foreign is intended:
                        continue
                    b = foreign['bbox']
                    if b[2] <= x or b[0] >= x+w or b[3] <= y or b[1] >= y+h:
                        continue
                    self.assertFalse(any(visible(q, frame, width) for q in foreign['pixels']), (character, name, 'foreign alpha >=16'))
                previous_groups.setdefault(tuple(old), []).append(name)
                current_groups.setdefault(json.dumps([frame['rect'], frame.get('clip')]), []).append(name)
                total += 1
            self.assertEqual(sorted(previous_groups.values()), sorted(current_groups.values()), character+' accidental pose duplication')
        self.assertEqual(total, 159)

    def test_original_equal_cuts_reproduce_missing_tails_and_neighbor_pixels(self):
        fixtures = [('deepseek', 'idle2', [410, 0, 204, 215]),
                    ('deepseek', 'ko3', [683, 1362, 170, 174]),
                    ('claude', 'kick3', [418, 709, 139, 246])]
        for character, name, rect in fixtures:
            width, poses = self.sources[character]
            old_frame = {'rect': rect}
            intended = max(poses, key=lambda p: sum(visible(q, old_frame, width) for q in p['core']))
            missing = sum(not visible(q, old_frame, width) for q in intended['core'])
            foreign = sum(visible(q, old_frame, width) for p in poses if p is not intended for q in p['core'])
            self.assertGreater(missing+foreign, 0, (character, name, 'regression fixture must fail'))
            fixed = self.registry[character]['frames'][name]
            self.assertTrue(all(visible(q, fixed, width) for q in intended['core']))
            self.assertFalse(any(visible(q, fixed, width) for p in poses if p is not intended for q in p['core']))


if __name__ == '__main__':
    unittest.main()
