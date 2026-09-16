"""One-off icon generator for the app's mark -- a small pixel-art owl (the
sidebar/PWA/desktop logo, favicon, and app icon). Not part of the running
app -- run once (`python scripts/gen_icons.py`) whenever the design needs to
change.

Drawn procedurally with basic shapes (rounded rects / ellipses / polygons)
on a small LOW_RES canvas, then scaled up with nearest-neighbor resampling
-- that's what gives the crisp, blocky pixel-art edges instead of a smooth
vector look, and is far more reliable to get right than hand-authoring a
pixel grid character-by-character.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BG_COLOR = (11, 13, 18)          # --bg from style.css (dark, matches the app's own theme)
OUTLINE_COLOR = (30, 27, 75)     # a dark indigo -- an outline that's "a shade of the brand", not flat black
BODY_COLOR = (99, 102, 241)      # --accent-strong
EYE_COLOR = (255, 255, 255)
PUPIL_COLOR = (17, 17, 17)
BEAK_COLOR = (251, 146, 60)      # --orange

LOW_RES = 24  # the actual pixel-art grid; everything else is this scaled up


def draw_owl(canvas_size: int = LOW_RES) -> Image.Image:
    img = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Ear tufts (small triangles behind the head, drawn first so the head
    # overlaps their base).
    draw.polygon([(4, 6), (8, 6), (4, 1)], fill=OUTLINE_COLOR)
    draw.polygon([(20, 6), (16, 6), (20, 1)], fill=OUTLINE_COLOR)

    # Body/head as one rounded blob (small pixel-art owls read fine without
    # a separate head/body split) -- outline layer drawn slightly larger,
    # fill layer drawn inset on top, giving a clean ~1px outline for free.
    draw.rounded_rectangle([2, 4, 21, 22], radius=6, fill=OUTLINE_COLOR)
    draw.rounded_rectangle([3, 5, 20, 21], radius=5, fill=BODY_COLOR)

    # Eyes -- big and round, the single most important feature for reading
    # as "owl" at a glance even at 16px.
    draw.ellipse([4, 8, 11, 15], fill=EYE_COLOR)
    draw.ellipse([13, 8, 20, 15], fill=EYE_COLOR)
    draw.ellipse([6, 10, 9, 13], fill=PUPIL_COLOR)
    draw.ellipse([15, 10, 18, 13], fill=PUPIL_COLOR)

    # Beak.
    draw.polygon([(11, 14), (13, 14), (12, 17)], fill=BEAK_COLOR)

    # Feet.
    draw.rectangle([7, 20, 9, 22], fill=BEAK_COLOR)
    draw.rectangle([15, 20, 17, 22], fill=BEAK_COLOR)

    return img


def make_icon(size: int, transparent: bool = False) -> Image.Image:
    owl = draw_owl().resize((size, size), Image.NEAREST)
    if transparent:
        return owl
    bg = Image.new("RGBA", (size, size), (*BG_COLOR, 255))
    radius = round(size * 0.22)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    rounded_bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded_bg.paste(bg, (0, 0), mask)
    rounded_bg.alpha_composite(owl)
    return rounded_bg.convert("RGB")


for size, name in [(180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
    make_icon(size).save(OUT_DIR / name)
    print(f"wrote {OUT_DIR / name}")

# A transparent-background favicon -- browsers composite it onto their own
# tab-bar chrome, so a solid square background would show as an ugly box.
make_icon(64, transparent=True).save(OUT_DIR / "favicon.png")
print(f"wrote {OUT_DIR / 'favicon.png'}")

# Windows .ico for the Electron desktop app / installer -- a single .ico
# with multiple sizes embedded, which is what electron-builder and Windows
# itself (taskbar, shortcuts, Explorer thumbnails) expect.
ico_sizes = [16, 32, 48, 64, 128, 256]
base = make_icon(256)
ico_path = OUT_DIR / "icon.ico"
base.save(ico_path, sizes=[(s, s) for s in ico_sizes])
print(f"wrote {ico_path}")

# macOS .icns for the Electron desktop app -- Pillow can write this format
# without any Apple-specific tooling (iconutil), so it's buildable from any
# OS; electron-builder's mac target and the BrowserWindow icon option both
# expect it. Apple's own guidance tops out at 1024px for the largest tile.
icns_path = OUT_DIR / "icon.icns"
make_icon(1024).save(icns_path, sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512, 1024)])
print(f"wrote {icns_path}")

# Plain PNG -- used as the BrowserWindow icon on macOS/Linux (the .icns/.ico
# containers are for the packaged app bundle and installer, not that API).
png_path = OUT_DIR / "icon.png"
make_icon(512).save(png_path)
print(f"wrote {png_path}")
