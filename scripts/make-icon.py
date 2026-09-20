from __future__ import annotations

import base64
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'build' / 'icon-source.png'
FRAME_DIR = ROOT / 'build' / 'icon-frames'
ICO_OUT = ROOT / 'build' / 'icon.ico'
SVG_OUT = ROOT / 'build' / 'icon.svg'
SIZES = (16, 32, 48, 256)
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def read_rgba_png(path: Path, expected_size: int) -> bytes:
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE or data[12:16] != b'IHDR':
        raise ValueError(f'{path} is not a PNG with an IHDR header')
    width, height = struct.unpack('>II', data[16:24])
    bit_depth, color_type = data[24], data[25]
    if (width, height) != (expected_size, expected_size):
        raise ValueError(f'Expected {expected_size}x{expected_size} in {path}, got {width}x{height}')
    if (bit_depth, color_type) != (8, 6):
        raise ValueError(f'Expected 8-bit RGBA PNG in {path}, got bit_depth={bit_depth} color_type={color_type}')
    return data


def write_ico(frames: list[tuple[int, bytes]]) -> None:
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    directory = bytearray()
    payload = bytearray()
    for size, data in frames:
        encoded_size = 0 if size == 256 else size
        directory.extend(struct.pack('<BBBBHHII', encoded_size, encoded_size, 0, 0, 1, 32, len(data), offset))
        payload.extend(data)
        offset += len(data)
    ICO_OUT.write_bytes(header + directory + payload)


def main() -> None:
    # The 1024px master uses Merdeka's in-game portrait from the locally owned
    # PEPPERED assets. Tracked RGBA frames keep regeneration stdlib-only.
    read_rgba_png(SOURCE, 1024)
    frames = [(size, read_rgba_png(FRAME_DIR / f'{size}.png', size)) for size in SIZES]
    write_ico(frames)

    payload = base64.b64encode(dict(frames)[256]).decode('ascii')
    SVG_OUT.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" '
        'aria-label="PEPPERED Save Manager icon — Merdeka portrait">\n'
        f'  <image width="256" height="256" href="data:image/png;base64,{payload}"/>\n'
        '</svg>\n',
        encoding='utf-8',
    )

    print(f'Wrote {ICO_OUT} ({ICO_OUT.stat().st_size} bytes; sizes={SIZES})')
    print(f'Wrote {SVG_OUT} ({SVG_OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
