"""
生成一套起步用的文字表情包。

为什么用文字图：模型没法凭空产出图片，而"点单式发图"要求本地库里有东西。
文字表情包是零成本、零版权风险、立刻可用的起点；之后往 stickers/ 里
丢真人表情包（文件名改成标签即可）就能无缝替换掉。

跑法：python tools/make-stickers.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

# 本机控制台默认是 GBK，直接 print 中文/符号会炸，先切 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "stickers"))
os.makedirs(OUT, exist_ok=True)

SIZE = 240

# (标签, 背景色, 文字色)
STICKERS = [
    ("开心", "#FFD166", "#3A2A00"),
    ("大笑", "#FFB4A2", "#4A1B0C"),
    ("摸摸头", "#A0E7E5", "#08343A"),
    ("加油", "#B4F8C8", "#0B3D1F"),
    ("害羞", "#FFC2D1", "#5A1130"),
    ("无语", "#D0D0D0", "#2B2B2B"),
    ("委屈", "#C7CEEA", "#1F2447"),
    ("好耶", "#FBE7C6", "#4A3200"),
    ("在的", "#CDE7FF", "#0A2A4A"),
    ("晚安", "#2E2A4A", "#E8E3FF"),
]

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",     # 微软雅黑
    r"C:\Windows\Fonts\simhei.ttf",   # 黑体
    r"C:\Windows\Fonts\msyhbd.ttf",
]


def find_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    raise SystemExit("找不到可用的中文字体，检查 C:\\Windows\\Fonts")


def fit_font(draw, text, max_width, start=96, min_size=28):
    """从大到小试，直到文字宽度塞得进画面。"""
    size = start
    while size > min_size:
        font = find_font(size)
        box = draw.textbbox((0, 0), text, font=font)
        if box[2] - box[0] <= max_width:
            return font
        size -= 4
    return find_font(min_size)


def make(tag, bg, fg):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([(0, 0), (SIZE - 1, SIZE - 1)], radius=40, fill=bg)
    # 一圈浅白内描边，缩略图里更精神
    d.rounded_rectangle([(7, 7), (SIZE - 8, SIZE - 8)], radius=34, outline=(255, 255, 255, 110), width=3)

    font = fit_font(d, tag, SIZE - 56)
    box = d.textbbox((0, 0), tag, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1]), tag, font=font, fill=fg)

    path = os.path.join(OUT, f"{tag}.png")
    img.save(path, "PNG")
    return path


def main():
    print(f"输出目录：{OUT}")
    for tag, bg, fg in STICKERS:
        p = make(tag, bg, fg)
        print(f"  [OK] {os.path.basename(p)}")
    print(f"共 {len(STICKERS)} 张。文件名就是模型要写的标签，例如 [[图:开心]]")


if __name__ == "__main__":
    main()
