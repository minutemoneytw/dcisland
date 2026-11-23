"""把 DibbelGames「16x16 Emotes Pack」的 Emotes.zip（每個表情一張 128×128、等於 16×16 放大 8 倍）
縮回原本的 16×16，拼成 client/assets/emotes/emotes.png（5 欄 × 5 列、每格 16px）。
用法：python tools/import_emotes.py <Emotes.zip>
只用標準庫。emote_00～07 是泡泡長大的動畫，emote_08～32 才是 25 個表情（順序＝emotes.json 的順序，與預覽圖的排列不同）。"""
import sys, zlib, struct, zipfile, os

def read_png(b):
    assert b[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, plte, trns = 8, b'', None, None
    while pos < len(b):
        n, t = struct.unpack('>I4s', b[pos:pos + 8]); d = b[pos + 8:pos + 8 + n]; pos += 12 + n
        if t == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', d[:10]); assert bd == 8 and d[12] == 0
        elif t == b'IDAT': idat += d
        elif t == b'PLTE': plte = d
        elif t == b'tRNS': trns = d
    raw = zlib.decompress(idat); ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]; stride = w * ch
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]; cur = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = cur[i - ch] if i >= ch else 0; u = prev[i]; c = prev[i - ch] if i >= ch else 0
            if f == 1: cur[i] = (cur[i] + a) & 255
            elif f == 2: cur[i] = (cur[i] + u) & 255
            elif f == 3: cur[i] = (cur[i] + (a + u) // 2) & 255
            elif f == 4:
                p = a + u - c; pa, pb, pc = abs(p - a), abs(p - u), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else u if pb <= pc else c)) & 255
        rows.append(cur); prev = cur
    def px(x, y):
        r = rows[y]
        if ct == 6: return tuple(r[x * 4:x * 4 + 4])
        if ct == 2: return (*r[x * 3:x * 3 + 3], 255)
        if ct == 3:
            i = r[x]; return (*plte[i * 3:i * 3 + 3], trns[i] if trns and i < len(trns) else 255)
        raise SystemExit('不支援的 PNG 色彩類型 %d' % ct)
    return w, h, px

def write_png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d))
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

z = zipfile.ZipFile(sys.argv[1])
COLS, N = 5, 25
sheet = bytearray(COLS * 16 * 5 * 16 * 4)
for k in range(N):
    w, h, px = read_png(z.read('emote_%02d.png' % (8 + k))); s = w // 16
    for y in range(16):
        for x in range(16):
            c = px(x * s + s // 2, y * s + s // 2)
            o = ((k // COLS * 16 + y) * COLS * 16 + (k % COLS * 16 + x)) * 4; sheet[o:o + 4] = bytes(c)
out = os.path.join(os.path.dirname(__file__), '..', 'client', 'assets', 'emotes'); os.makedirs(out, exist_ok=True)
write_png(os.path.join(out, 'emotes.png'), COLS * 16, 5 * 16, sheet)
print('ok', out)
