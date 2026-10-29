# -*- coding: utf-8 -*-
"""无第三方依赖生成应用图标：圆角渐变底 + 书本图形，输出 ico/png。"""
import zlib, struct, os, math

M = 512  # 主画布（超采样）

def lerp(a, b, t):
    return a + (b - a) * t

def make_master():
    buf = bytearray(M * M * 4)  # RGBA
    c1 = (59, 116, 232)   # #3b74e8
    c2 = (27, 74, 190)    # #1b4abe

    def put(x, y, r, g, b, a):
        i = (y * M + x) * 4
        # 简单 over 合成（背景是透明）
        sa = a / 255.0
        da = buf[i + 3] / 255.0
        oa = sa + da * (1 - sa)
        if oa <= 0:
            return
        for k, v in enumerate((r, g, b)):
            buf[i + k] = int((v * sa + buf[i + k] * da * (1 - sa)) / oa)
        buf[i + 3] = int(oa * 255)

    def rounded_rect(x0, y0, x1, y1, rad, color, alpha=255):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                # 到圆角矩形的距离
                cx = min(max(x, x0 + rad), x1 - rad)
                cy = min(max(y, y0 + rad), y1 - rad)
                d = math.hypot(x - cx, y - cy) - rad
                if d <= 0:
                    put(x, y, color[0], color[1], color[2], alpha)

    # 底：圆角方形 + 对角渐变
    pad = 26
    rad = 110
    for y in range(M):
        for x in range(M):
            cx = min(max(x, pad + rad), M - pad - rad)
            cy = min(max(y, pad + rad), M - pad - rad)
            d = math.hypot(x - cx, y - cy) - rad
            if d <= 0:
                t = (x + y) / (2.0 * M)
                put(x, y, int(lerp(c1[0], c2[0], t)), int(lerp(c1[1], c2[1], t)), int(lerp(c1[2], c2[2], t)), 255)

    # 书本：左右两页 + 中缝
    white = (255, 255, 255)
    soft = (214, 226, 248)
    rounded_rect(118, 138, 250, 388, 14, white, 245)
    rounded_rect(262, 138, 394, 388, 14, white, 245)
    # 中缝阴影
    rounded_rect(244, 138, 268, 388, 8, (170, 196, 240), 160)
    # 文字线条
    for i in range(5):
        y = 190 + i * 36
        rounded_rect(140, y, 232, y + 10, 5, soft, 255)
        rounded_rect(280, y, 372, y + 10, 5, soft, 255)
    return buf


def downsample(buf, src, dst):
    f = src // dst
    out = bytearray(dst * dst * 4)
    for y in range(dst):
        for x in range(dst):
            r = g = b = a = 0
            for dy in range(f):
                for dx in range(f):
                    i = ((y * f + dy) * src + (x * f + dx)) * 4
                    r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]
            n = f * f
            j = (y * dst + x) * 4
            out[j] = r // n; out[j + 1] = g // n; out[j + 2] = b // n; out[j + 3] = a // n
    return out


def png_bytes(rgba, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw += rgba[y * size * 4:(y + 1) * size * 4]
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(here, exist_ok=True)
    master = make_master()
    sizes = [256, 64, 32, 16]
    pngs = {}
    for s in sizes:
        pngs[s] = png_bytes(downsample(master, M, s) if s != M else master, s)

    # ICO：PNG 内嵌
    entries = b''
    data = b''
    offset = 6 + 16 * len(sizes)
    for s in sizes:
        blob = pngs[s]
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    ico = struct.pack('<HHH', 0, 1, len(sizes)) + entries + data

    open(os.path.join(here, 'icon.ico'), 'wb').write(ico)
    open(os.path.join(here, 'icon.png'), 'wb').write(pngs[256])
    open(os.path.join(here, 'tray.png'), 'wb').write(pngs[32])
    print('icon.ico / icon.png / tray.png 已生成', len(ico), 'bytes')


if __name__ == '__main__':
    main()
