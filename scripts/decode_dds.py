"""BC7 DDS -> PNG 解码器（CPU 解压，绕过软件渲染器的 BC7 硬解 bug）。

用法: python decode_dds.py <input.dds> <output.png>
依赖: texture2ddecoder, Pillow（通过 PYTHONPATH 提供）
"""
import sys
import struct
from PIL import Image

try:
    import texture2ddecoder
except ImportError:
    print('ERROR: texture2ddecoder not found', file=sys.stderr)
    sys.exit(2)


def decode_dds(dds_path, out_png):
    with open(dds_path, 'rb') as f:
        data = f.read()
    if data[:4] != b'DDS ':
        return False, 'not a DDS file'
    height = struct.unpack_from('<I', data, 12)[0]
    width = struct.unpack_from('<I', data, 16)[0]
    pf_four_cc = data[84:88]
    # BC7 块数据从 148 开始（128B 标准 DDS 头 + 20B DX10 头）
    block = data[148:]
    if pf_four_cc == b'DX10':
        rgba = texture2ddecoder.decode_bc7(block, width, height)
    elif pf_four_cc in (b'DXT1', b'DXT3', b'DXT5'):
        # 退回 texture2ddecoder 的对应解压器
        if pf_four_cc == b'DXT1':
            rgba = texture2ddecoder.decode_bc1(block, width, height)
        elif pf_four_cc == b'DXT3':
            rgba = texture2ddecoder.decode_bc2(block, width, height)
        else:
            rgba = texture2ddecoder.decode_bc3(block, width, height)
    else:
        return False, 'unsupported fourCC: ' + repr(pf_four_cc)
    img = Image.frombytes('RGBA', (width, height), rgba)
    # 以 PNG 保存（带 mipmap 友好的 2 的幂尺寸由原图保证）
    img.save(out_png, 'PNG')
    return True, f'ok {width}x{height}'


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('usage: decode_dds.py <input.dds> <output.png>', file=sys.stderr)
        sys.exit(2)
    ok, msg = decode_dds(sys.argv[1], sys.argv[2])
    print(msg)
    sys.exit(0 if ok else 1)
