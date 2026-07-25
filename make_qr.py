#!/usr/bin/env python3
"""
Generates the WiFi-join QR code label for the ESP32 environment monitor.

Scanning the code joins the device's access point. The captive portal in the
sketch then opens the web app automatically -- no IP address to type.

Re-run this whenever you change AP_SSID or AP_PASS in the sketch.
"""

from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

# ── Must match AP_SSID / AP_PASS in the sketch ────────────────────────────
SSID = "scout-361"
PASSWORD = "yourPassword"
AUTH = "WPA"          # WPA covers WPA/WPA2. Use "nopass" for an open AP.
HIDDEN = False

OUT = str(Path(__file__).resolve().parent / "wifi_qr_label.png")


def escape(s: str) -> str:
    """Backslash-escape the characters the WIFI: format treats specially."""
    for ch in ["\\", ";", ",", ":", '"']:
        s = s.replace(ch, "\\" + ch)
    return s


payload = "WIFI:T:{auth};S:{ssid};P:{pw};{hidden};".format(
    auth=AUTH,
    ssid=escape(SSID),
    pw=escape(PASSWORD),
    hidden="H:true" if HIDDEN else "",
)

print("QR payload:", payload)

qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_H,  # survives scuffs/glare
    box_size=12,
    border=3,
)
qr.add_data(payload)
qr.make(fit=True)
qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

# ── Compose a printable label with caption text ───────────────────────────
W = qr_img.width
label = Image.new("RGB", (W, qr_img.height + 150), "white")
label.paste(qr_img, (0, 0))
draw = ImageDraw.Draw(label)


def load_font(size, bold=False):
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def centered(text, y, font, fill="black"):
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text(((W - (bbox[2] - bbox[0])) / 2, y), text, font=font, fill=fill)


centered("SCAN TO VIEW SENSOR DATA", qr_img.height + 5, load_font(30, bold=True))
centered(f"Network: {SSID}", qr_img.height + 50, load_font(24))
centered("Page opens automatically once connected", qr_img.height + 84, load_font(20), "#666666")
centered("Otherwise browse to 192.168.4.1", qr_img.height + 112, load_font(20), "#666666")

label.save(OUT, dpi=(300, 300))
print("Wrote", OUT, label.size)
