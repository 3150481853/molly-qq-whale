from PIL import Image, ImageDraw, ImageFont
import os

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 墨绿圆角方块 + 暖纸 M
d.rounded_rectangle((8, 8, S - 8, S - 8), radius=58, fill=(23, 63, 53, 255))
font = None
for path in (r"C:\Windows\Fonts\georgiab.ttf", r"C:\Windows\Fonts\georgia.ttf", r"C:\Windows\Fonts\segoeuib.ttf"):
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 150)
            break
        except Exception:
            pass
text = "M"
if font is None:
    font = ImageFont.load_default()
box = d.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
d.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] - 6), text, font=font, fill=(244, 245, 241, 255))
out = r"${MOLLY_ROOT}\qq-whale\desktop\Assets\Molly.ico"
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(out, os.path.getsize(out))
