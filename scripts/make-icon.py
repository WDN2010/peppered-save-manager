from __future__ import annotations

import struct
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'build' / 'icon.ico'


def pixel(size: int, x: int, y: int) -> tuple[int, int, int, int]:
    scale = size / 256
    px, py = x / scale, y / scale
    # Original checkpoint/P mark: dark rounded tile, violet ring, white P, gold checkpoint.
    if 12 <= px <= 244 and 12 <= py <= 244:
        edge = min(px - 12, 244 - px, py - 12, 244 - py)
        if edge < 10 or ((px - 128) ** 2 + (py - 128) ** 2) ** 0.5 > 86:
            return (154, 140, 255, 255)
        if ((px - 128) ** 2 + (py - 128) ** 2) ** 0.5 <= 78:
            # P stroke.
            if 87 <= px <= 105 and 70 <= py <= 186:
                return (244, 240, 255, 255)
            if 97 <= px <= 143 and 70 <= py <= 88:
                return (244, 240, 255, 255)
            if 97 <= px <= 143 and 122 <= py <= 140:
                return (244, 240, 255, 255)
            if 133 <= px <= 177 and 78 <= py <= 132 and ((px - 138) ** 2 + (py - 105) ** 2) ** 0.5 <= 42:
                return (244, 240, 255, 255)
            if ((px - 128) ** 2 + (py - 128) ** 2) ** 0.5 <= 11:
                return (242, 200, 121, 255)
            return (40, 35, 77, 255)
        return (23, 23, 34, 255)
    return (0, 0, 0, 0)


def dib(size: int) -> bytes:
    rows = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = pixel(size, x, y)
            rows.extend((b, g, r, a))
    mask_stride = ((size + 31) // 32) * 4
    mask = bytes(mask_stride * size)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(rows) + len(mask), 0, 0, 0, 0)
    return header + rows + mask


images = [(size, dib(size)) for size in (16, 32, 48, 256)]
header = struct.pack('<HHH', 0, 1, len(images))
offset = 6 + 16 * len(images)
directory = bytearray()
payload = bytearray()
for size, data in images:
    width = 0 if size == 256 else size
    directory.extend(struct.pack('<BBBBHHII', width, width, 0, 0, 1, 32, len(data), offset))
    payload.extend(data)
    offset += len(data)
OUT.write_bytes(header + directory + payload)
print(f'Wrote {OUT} ({OUT.stat().st_size} bytes)')
