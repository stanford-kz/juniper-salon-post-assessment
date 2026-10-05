#!/usr/bin/env python3
"""Build the five-page customer presentation; all customer facts are from discovery.

Optional verified application screenshot:
  python build_presentation.py --screenshot /absolute/path.png
"""
from pathlib import Path
import argparse
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output/pdf/juniper-salon-waitlist.pdf"
W, H = 960, 540
CREAM = colors.HexColor("#f8f7f2")
INK = colors.HexColor("#222c29")
GREEN = colors.HexColor("#244d41")
MUTED = colors.HexColor("#5c6662")
RULE = colors.HexColor("#d5cfc2")
WHITE = colors.HexColor("#fffdf8")

FONTS = Path("/System/Library/Fonts/Supplemental")
for name, filename in [("Body", "Arial.ttf"), ("Bold", "Arial Bold.ttf"),
                       ("Title", "Georgia.ttf"), ("Italic", "Georgia Italic.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / filename)))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Bold", italic="Body", boldItalic="Bold")

parser = argparse.ArgumentParser()
parser.add_argument("--screenshot", type=Path, default=ROOT / "assets/juniper-dashboard.jpg")
args = parser.parse_args()
if args.screenshot and not args.screenshot.is_file():
    raise FileNotFoundError(args.screenshot)

OUT.parent.mkdir(parents=True, exist_ok=True)
c = canvas.Canvas(str(OUT), pagesize=(W, H))
c.setTitle("Juniper Salon | Cancellation waitlist")
c.setAuthor("Kayvan")
c.setSubject("Customer prototype and proposed trial for Lena and Carla")

def text(value, x, y, size=18, font="Body", color=INK):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, H-y-size, value)

def para(value, x, y, width, size=18, leading=None, color=INK, font="Body", max_height=None):
    style = ParagraphStyle("p", fontName=font, fontSize=size, leading=leading or size*1.35,
                           textColor=color, spaceAfter=0, allowWidows=0, allowOrphans=0)
    p = Paragraph(value, style)
    _, height = p.wrap(width, H)
    if max_height is not None and height > max_height:
        raise ValueError(f"Text too tall: {height:.1f} > {max_height}: {value}")
    p.drawOn(c, x, H-y-height)
    return height

def line(y, x1=52, x2=908, color=RULE):
    c.setStrokeColor(color)
    c.setLineWidth(.7)
    c.line(x1, H-y, x2, H-y)

def base(n, dark=False):
    c.setFillColor(GREEN if dark else CREAM)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    footer_color = colors.HexColor("#d8e2dc") if dark else MUTED
    text("JUNIPER SALON", 52, 506, size=9.5, font="Bold", color=footer_color)
    c.setFillColor(footer_color)
    c.setFont("Body", 9.5)
    c.drawRightString(908, 24, f"{n} / 5")

def title(value, subtitle=None):
    para(value, 52, 44, 856, size=34, leading=41, font="Title", max_height=84)
    if subtitle:
        para(subtitle, 52, 101, 850, size=17, color=MUTED, max_height=48)

def finish():
    c.showPage()

# 1: the customer problem and a clearly prospective target.
base(1)
text("FOR LENA & CARLA", 54, 44, 11, "Bold", GREEN)
para("The cancellation<br/>waitlist", 52, 87, 555, 49, 56, font="Title", max_height=120)
para("A clear offer for each client.<br/>Less chasing for the front desk.",
     54, 226, 470, 23, 32, color=GREEN, max_height=70)
para("Competing staff texts promised one Saturday opening to two clients. One arrived expecting a booking and left angry.",
     54, 354, 455, 19, 27, max_height=90)
text("ABOUT", 646, 107, 11, "Bold", MUTED)
text("3 / 10", 642, 119, 55, "Title", GREEN)
para("cancelled slots filled today<br/>Lena's estimate", 646, 193, 240, 18, 25, color=MUTED)
line(277, 646, 908)
text("TRIAL TARGET", 646, 308, 11, "Bold", MUTED)
text("5 / 10", 642, 322, 55, "Title", GREEN)
para("or more refilled<br/>A goal, not a measured result", 646, 394, 260, 18, 25, color=MUTED)
finish()

# 2: business process. Sequential copy is kept flat and readable.
base(2)
title("One offer at a time", "Eligible clients are contacted in the order they joined the waitlist.")
rows = [
    ("01", "Match the opening", "Match service, availability and required stylist. Skip clients who opted out of texts."),
    ("02", "Offer 15 minutes", "Contact one client. Show the service, stylist, appointment time and offer deadline."),
    ("03", "Keep moving", "A decline or timeout advances to the next eligible client. They stay on the waitlist."),
    ("04", "Fill once", "A timely acceptance fills this opening. Lena or Carla then updates Square manually."),
]
for idx, (num, heading, detail) in enumerate(rows):
    y = 163 + idx*79
    text(num, 53, y+2, 22, "Title", GREEN)
    text(heading, 110, y, 21, "Bold")
    para(detail, 375, y, 515, 18, 24, max_height=53)
    if idx < 3:
        line(y+63, 110, 907)
finish()

# 3: optional genuine app evidence. Without a screenshot the slide remains useful
# and contains no visual placeholder or fabricated product image.
base(3)
title("The front desk stays in control")
if args.screenshot:
    img = ImageReader(str(args.screenshot))
    iw, ih = img.getSize()
    box_x, box_y, box_w, box_h = 52, 129, 612, 329
    scale = min(box_w/iw, box_h/ih)
    dw, dh = iw*scale, ih*scale
    c.drawImage(img, box_x, H-box_y-dh, width=dw, height=dh, mask="auto")
    x, width = 701, 207
    para("See the outcome", x, 134, width, 20, 26, font="Bold")
    para("The accepted client is named, with a reminder to update Square.", x, 178, width, 18, 25, color=MUTED)
    para("Act when needed", x, 285, width, 20, 26, font="Bold")
    para("Retry or skip a failed send. Withdraw an opening that disappears.", x, 327, width, 18, 25, color=MUTED)
    text("Prototype screen. Text messages are simulated.", 53, 474, 11, color=MUTED)
else:
    para("Know who has the offer", 54, 154, 375, 25, 32, font="Title", color=GREEN)
    para("See the current client and deadline, who declined or timed out, and whether anyone remains.", 54, 206, 375, 21, 29, max_height=115)
    para("Handle exceptions visibly", 525, 154, 383, 25, 32, font="Title", color=GREEN)
    para("A failed send pauses for a staff decision: retry or skip. Withdraw an opening if a walk-in takes it or the stylist is unavailable.", 525, 206, 383, 21, 29, max_height=145)
    line(394)
    para("When no eligible clients remain, the opening is marked unfilled so the desk knows the outcome.", 54, 419, 848, 20, 27, max_height=57)
finish()

# 4: Temporal is explained through consequences that matter to the customer.
base(4, dark=True)
para("The offer survives interruptions", 52, 47, 856, 34, 42, font="Title", color=WHITE, max_height=85)
para("Temporal remembers the offer, its deadline and the replies. Restarting the service keeps the original clock running.",
     54, 131, 831, 23, 32, color=WHITE, max_height=75)
rules = [
    ("The promise stays current", "Late or duplicate replies cannot claim the opening. Withdrawing it ends the active offer."),
    ("Consent can change", "If the active client opts out, end the offer and move to the next eligible person."),
    ("Outreach follows salon hours", "Normal mode: Tue-Sat, 9 a.m.-6 p.m., Phoenix time. Wait until reopening; stop at the appointment start."),
]
for i, (heading, detail) in enumerate(rules):
    y = 252+i*73
    text(heading, 54, y, 18, "Bold", WHITE)
    para(detail, 364, y, 526, 18, 24, color=colors.HexColor("#e1e8e2"), max_height=57)
finish()

# 5: trial proposal, scope and boundaries. These are not achieved results.
base(5)
title("A small trial with Lena and Carla", "Proposed next step: review the next 10 last-minute cancellations together.")
text("WHAT TO MEASURE", 54, 163, 11, "Bold", GREEN)
para("Refilled slots", 54, 195, 380, 27, 34, font="Title", color=GREEN)
para("Count filled / total cancellations.<br/>Aim for at least 5 of 10; today is about 3.", 54, 243, 378, 19, 27, max_height=84)
para("Staff effort and mix-ups", 54, 330, 398, 25, 32, font="Title", color=GREEN)
para("Count manual checks or texts per opening. Record any duplicate promise or late-reply issue. Review results with Lena and Carla.",
     54, 376, 384, 19, 27, max_height=95)
text("WHAT THIS PROTOTYPE SHOWS", 520, 163, 11, "Bold", GREEN)
para("Simulated texts. Waitlist saved in this browser. No staff login. Square updates stay manual.",
     520, 197, 388, 19, 27, max_height=95)
para("Demo mode uses 20-second offers and an open-salon clock. Normal mode uses 15 minutes and real salon hours.",
     520, 302, 388, 19, 27, max_height=105)
para("Before a live trial: connect SMS, add access controls, and check Square booking conflicts.",
     520, 411, 388, 17, 24, color=MUTED, max_height=75)
finish()

c.save()
print(OUT)
