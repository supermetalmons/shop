import json
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path


HERE = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1920, 1080


def png(pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", len(pixels), 1, 8, 6, 0, 0, 0)
    scanline = b"\0" + b"".join(bytes(pixel) for pixel in pixels)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanline)) + chunk(b"IEND", b"")


def write_glb(path, layers=((0, 0.25),), offset=0, unused=False, flip=False, blend=False, double_sided=True):
    data = bytearray()
    views, accessors, primitives = [], [], []

    def view(payload):
        data.extend(b"\0" * (-len(data) % 4))
        views.append({"buffer": 0, "byteOffset": len(data), "byteLength": len(payload)})
        data.extend(payload)
        return len(views) - 1

    def accessor(rows, fmt="f"):
        columns = len(rows[0])
        payload = b"".join(struct.pack("<" + fmt * columns, *row) for row in rows)
        accessors.append({
            "bufferView": view(payload), "componentType": 5126 if fmt == "f" else 5123,
            "count": len(rows), "type": ("SCALAR", "VEC2", "VEC3")[columns - 1],
            "min": list(map(min, zip(*rows))), "max": list(map(max, zip(*rows))),
        })
        return len(accessors) - 1

    indices = accessor([(i,) for i in ((0, 1, 3, 1, 2, 3) if flip else (0, 1, 2, 0, 2, 3))], "H")
    for depth, u in layers:
        positions = [(x + offset, y + offset, depth)
                     for x, y in [(-0.125, -0.0625), (0.125, -0.0625), (0.125, 0.0625), (-0.125, 0.0625)]]
        if unused:
            positions.append((40, 40, 0))
        attributes = {"POSITION": accessor(positions), "NORMAL": accessor([(0, 0, 1)] * len(positions)),
                      "TEXCOORD_0": accessor([(u, 0.5)] * len(positions))}
        primitives.append({"indices": indices, "attributes": attributes, "material": 0})

    alpha = 180 if blend else 255
    textures = [png([(255, 0, 0, alpha), (0, 0, 255, alpha)]), png([(128, 128, 255, 255)]), png([(0, 160, 0, 255)])]
    images = [{"bufferView": view(image), "mimeType": "image/png"} for image in textures]
    document = {
        "asset": {"version": "2.0"}, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": primitives}], "buffers": [{"byteLength": len(data)}],
        "bufferViews": views, "accessors": accessors, "images": images,
        "textures": [{"source": i} for i in range(3)],
        "materials": [{"doubleSided": double_sided, "alphaMode": "BLEND" if blend else "OPAQUE",
                       "normalTexture": {"index": 1}, "pbrMetallicRoughness": {
                           "baseColorTexture": {"index": 0}, "metallicRoughnessTexture": {"index": 2}}}],
    }
    encoded = json.dumps(document).encode()
    encoded += b" " * (-len(encoded) % 4)
    data.extend(b"\0" * (-len(data) % 4))
    chunks = struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(data), b"BIN\0") + data
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks)


class RendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = tempfile.TemporaryDirectory()
        cls.addClassCleanup(scratch.cleanup)
        cls.directory = Path(scratch.name)
        cls.renderer = cls.directory / "renderer"
        subprocess.run(["swiftc", "-O", HERE / "MetalRenderer.swift", "-o", cls.renderer], check=True)

    def frame(self, **geometry):
        model = self.directory / "model.glb"
        write_glb(model, **geometry)
        size = WIDTH * HEIGHT * 4
        with subprocess.Popen([self.renderer, model, HERE / "Knife.metal"], stdout=subprocess.PIPE) as process:
            try:
                pixels = process.stdout.read(size)
            finally:
                process.terminate()
        self.assertEqual(len(pixels), size)
        return pixels

    def test_framing(self):
        def silhouette(frame):
            return bytes(red - blue > 40 for red, blue in zip(frame[2::4], frame[0::4]))

        expected = silhouette(self.frame())
        area = expected.count(1)
        self.assertGreater(area, 10000)
        for change in ({"unused": True}, {"offset": 100}, {"flip": True}):
            with self.subTest(change=change):
                actual = silhouette(self.frame(**change))
                self.assertLess(sum(a != b for a, b in zip(actual, expected)), area * 0.001)

    def test_transparent_layers(self):
        def center(layers, double_sided):
            frame = self.frame(layers=layers, blend=True, double_sided=double_sided)
            start = ((HEIGHT // 2) * WIDTH + WIDTH // 2) * 4
            return frame[start:start + 3]

        near, far = (0.01, 0.25), (-0.01, 0.75)
        for double_sided in (True, False):
            with self.subTest(double_sided=double_sided):
                blue, _, red = center([far, near], double_sided)
                reversed_pixel = center([near, far], double_sided)
                self.assertGreater(red, blue + 20)
                self.assertGreater(blue, center([near], double_sided)[0] + 10)
                self.assertLessEqual(abs(red - reversed_pixel[2]), 1)
                self.assertLessEqual(abs(blue - reversed_pixel[0]), 1)


if __name__ == "__main__":
    unittest.main()
