#!/usr/bin/env python3
"""
Generates a two-QR-code label for the ESP32 environment monitor:

  1. WiFi-join code  -- scanning it joins the device's access point.
  2. Page-link code  -- a plain http:// QR for 192.168.4.1, so the phone's
     camera offers "Open in Safari" right after joining.

There's no way to make a single QR code both join a network and open a
browser -- a scanner dispatches to exactly one action per code. Two codes
scanned back-to-back is the reliable way to get both.

Re-run this whenever you change AP_SSID / AP_PASS in the sketch, or apIP.
"""

from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

# ── Must match AP_SSID / AP_PASS in the sketch ────────────────────────────
SSID = "scout-361"
PASSWORD = "yourPassword"
AUTH = "WPA"          # WPA covers WPA/WPA2. Use "nopass" for an open AP.
HIDDEN = False

# ── Must match apIP in the sketch ─────────────────────────────────────────
PAGE_URL = "http://192.168.4.1/"

OUT = str(Path(__file__).resolve().parent / "wifi_qr_label.png")


def escape(s: str) -> str:
    """Backslash-escape the characters the WIFI: format treats specially."""
    for ch in ["\\", ";", ",", ":", '"']:
        s = s.replace(ch, "\\" + ch)
    return s


wifi_payload = "WIFI:T:{auth};S:{ssid};P:{pw};{hidden};".format(
    auth=AUTH,
    ssid=escape(SSID),
    pw=escape(PASSWORD),
    hidden="H:true" if HIDDEN else "",
)

print("WiFi QR payload:", wifi_payload)
print("Page QR payload:", PAGE_URL)


def make_qr(data: str, box_size: int = 10) -> Image.Image:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,  # survives scuffs/glare
        box_size=box_size,
        border=3,
    )
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white").convert("RGB")


wifi_qr = make_qr(wifi_payload)
page_qr = make_qr(PAGE_URL)


def load_font(size, bold=False):
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT_TITLE = load_font(30, bold=True)
FONT_LABEL = load_font(24, bold=True)
FONT_SUB = load_font(20)
FONT_BADGE = load_font(34, bold=True)

# ── Compose a printable label: title, numbered badges, two QR codes, arrow ─
GAP = 60
MARGIN = 30
CODE_H = max(wifi_qr.height, page_qr.height)
TITLE_H = 50
BADGE_H = 70
CAPTION_H = 90
ACCENT = "#1a73e8"

W = MARGIN * 2 + wifi_qr.width + GAP + page_qr.width
H = TITLE_H + BADGE_H + CODE_H + CAPTION_H

label = Image.new("RGB", (W, H), "white")
draw = ImageDraw.Draw(label)


def centered(text, cx, y, font, fill="black"):
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((cx - (bbox[2] - bbox[0]) / 2, y), text, font=font, fill=fill)


def badge(number, cx, y, d=56):
    """A filled numbered circle marking step order."""
    draw.ellipse((cx - d / 2, y, cx + d / 2, y + d), fill=ACCENT)
    bbox = draw.textbbox((0, 0), number, font=FONT_BADGE)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], y + d / 2 - th / 2 - bbox[1]), number, font=FONT_BADGE, fill="white")


centered("SCAN TO VIEW SENSOR DATA", W / 2, 10, FONT_TITLE)

wifi_x = MARGIN
page_x = MARGIN + wifi_qr.width + GAP
qr_y = TITLE_H + BADGE_H
label.paste(wifi_qr, (wifi_x, qr_y))
label.paste(page_qr, (page_x, qr_y))

badge_y = TITLE_H + 8
badge("1", wifi_x + wifi_qr.width / 2, badge_y)
badge("2", page_x + page_qr.width / 2, badge_y)

# Arrow between the two codes, pointing from step 1 to step 2 (drawn, not
# a text glyph, so it renders the same regardless of installed fonts).
arrow_cy = qr_y + CODE_H / 2
arrow_cx = MARGIN + wifi_qr.width + GAP / 2
shaft_half, head_half, head_len = 4, 14, 18
draw.rectangle(
    (arrow_cx - GAP / 2 + 6, arrow_cy - shaft_half, arrow_cx + GAP / 2 - head_len, arrow_cy + shaft_half),
    fill=ACCENT,
)
draw.polygon(
    [
        (arrow_cx + GAP / 2 - head_len, arrow_cy - head_half),
        (arrow_cx + GAP / 2 - 6, arrow_cy),
        (arrow_cx + GAP / 2 - head_len, arrow_cy + head_half),
    ],
    fill=ACCENT,
)

caption_y = qr_y + CODE_H + 8
centered("JOIN WIFI FIRST", wifi_x + wifi_qr.width / 2, caption_y, FONT_LABEL)
centered(f"Network: {SSID}", wifi_x + wifi_qr.width / 2, caption_y + 34, FONT_SUB, "#666666")

centered("THEN OPEN PAGE", page_x + page_qr.width / 2, caption_y, FONT_LABEL)
centered("Once WiFi is connected", page_x + page_qr.width / 2, caption_y + 34, FONT_SUB, "#666666")

label.save(OUT, dpi=(300, 300))
print("Wrote", OUT, label.size)
