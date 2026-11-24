"""
Input Overlay – zeigt Xbox-Controller- oder Tastatur/Maus-Eingaben als
durchsichtiges Overlay über Spielen bzw. dem Desktop an.

Nur Python-Standardbibliothek (tkinter + ctypes). Gedacht für Windows 10/11.
Start:  pythonw input_overlay.py      (oder start_overlay.bat doppelklicken)
Test ohne Windows:  python input_overlay.py --demo
"""

import json
import math
import os
import sys
import time
import tkinter as tk
from tkinter import ttk

IS_WINDOWS = sys.platform == "win32"
DEMO = "--demo" in sys.argv

# Farbe, die unter Windows komplett durchsichtig gemacht wird.
KEY_COLOR = "#010101"

MIN_SCALE, MAX_SCALE = 0.4, 3.0
MODES = ("controller", "keyboard", "auto")
MODE_NAMES = {"controller": "Controller", "keyboard": "Tastatur & Maus", "auto": "Automatisch"}


# --------------------------------------------------------------------------
# Einstellungen
# --------------------------------------------------------------------------
def settings_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    folder = os.path.join(base, "InputOverlay")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "settings.json")


DEFAULTS = {
    "mode": "controller",
    "scale": 1.0,
    "opacity": 0.9,
    "visible": True,
    "locked": False,
    "x": 60,
    "y": 60,
}


def load_settings():
    s = dict(DEFAULTS)
    try:
        with open(settings_path(), "r", encoding="utf-8") as f:
            s.update(json.load(f))
    except Exception:
        pass
    if s["mode"] not in MODES:
        s["mode"] = "controller"
    s["scale"] = max(MIN_SCALE, min(MAX_SCALE, float(s["scale"])))
    s["opacity"] = max(0.2, min(1.0, float(s["opacity"])))
    return s


def save_settings(s):
    try:
        with open(settings_path(), "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Eingabe: Windows (XInput + GetAsyncKeyState)
# --------------------------------------------------------------------------
class PadState:
    __slots__ = ("buttons", "lt", "rt", "lx", "ly", "rx", "ry")

    def __init__(self, buttons=0, lt=0.0, rt=0.0, lx=0.0, ly=0.0, rx=0.0, ry=0.0):
        self.buttons, self.lt, self.rt = buttons, lt, rt
        self.lx, self.ly, self.rx, self.ry = lx, ly, rx, ry

    def key(self):
        return (self.buttons, round(self.lt, 2), round(self.rt, 2),
                round(self.lx, 2), round(self.ly, 2), round(self.rx, 2), round(self.ry, 2))

    def active(self):
        dz = 0.25
        return bool(self.buttons or self.lt > 0.1 or self.rt > 0.1 or
                    abs(self.lx) > dz or abs(self.ly) > dz or abs(self.rx) > dz or abs(self.ry) > dz)


# XInput-Buttonbits
DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT = 0x1, 0x2, 0x4, 0x8
BTN_MENU, BTN_VIEW, BTN_LS, BTN_RS = 0x10, 0x20, 0x40, 0x80
BTN_LB, BTN_RB, BTN_GUIDE = 0x100, 0x200, 0x400
BTN_A, BTN_B, BTN_X, BTN_Y = 0x1000, 0x2000, 0x4000, 0x8000


class WinInput:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.user32 = ctypes.windll.user32
        self.user32.GetAsyncKeyState.restype = ctypes.c_short
        self.user32.GetAsyncKeyState.argtypes = [ctypes.c_int]

        class XINPUT_GAMEPAD(ctypes.Structure):
            _fields_ = [("wButtons", wintypes.WORD),
                        ("bLeftTrigger", ctypes.c_ubyte),
                        ("bRightTrigger", ctypes.c_ubyte),
                        ("sThumbLX", ctypes.c_short),
                        ("sThumbLY", ctypes.c_short),
                        ("sThumbRX", ctypes.c_short),
                        ("sThumbRY", ctypes.c_short)]

        class XINPUT_STATE(ctypes.Structure):
            _fields_ = [("dwPacketNumber", wintypes.DWORD), ("Gamepad", XINPUT_GAMEPAD)]

        self._state = XINPUT_STATE()
        self._get = None
        for name in ("xinput1_4", "xinput1_3", "xinput9_1_0"):
            try:
                dll = getattr(ctypes.windll, name)
            except OSError:
                continue
            try:
                # Versteckte Funktion (Ordinal 100) liefert zusätzlich den Xbox-Button.
                fn = dll[100]
            except Exception:
                fn = dll.XInputGetState
            fn.argtypes = [wintypes.DWORD, ctypes.POINTER(XINPUT_STATE)]
            fn.restype = wintypes.DWORD
            self._get = fn
            break
        self.slot = None
        self._next_scan = 0.0

    def _read(self, slot):
        if self._get is None:
            return False
        return self._get(slot, self.ctypes.byref(self._state)) == 0

    def pad(self):
        """Liefert PadState oder None, wenn kein Controller verbunden ist."""
        if self.slot is not None and not self._read(self.slot):
            self.slot = None
        if self.slot is None:
            now = time.monotonic()
            if now < self._next_scan:
                return None
            self._next_scan = now + 1.0
            for i in range(4):
                if self._read(i):
                    self.slot = i
                    break
            else:
                return None
        g = self._state.Gamepad

        def ax(v):
            return max(-1.0, min(1.0, v / 32767.0))

        return PadState(g.wButtons, g.bLeftTrigger / 255.0, g.bRightTrigger / 255.0,
                        ax(g.sThumbLX), ax(g.sThumbLY), ax(g.sThumbRX), ax(g.sThumbRY))

    def key_down(self, vk):
        return bool(self.user32.GetAsyncKeyState(vk) & 0x8000)

    def vk_from_scancode(self, sc):
        return self.user32.MapVirtualKeyW(sc, 1)  # MAPVK_VSC_TO_VK

    def char_for_vk(self, vk):
        c = self.user32.MapVirtualKeyW(vk, 2) & 0xFFFF  # MAPVK_VK_TO_CHAR
        return chr(c).upper() if c else ""


class DemoInput:
    """Animierte Fake-Eingaben, damit man das Overlay ohne Windows testen kann."""

    slot = 0

    def __init__(self):
        self.t0 = time.monotonic()

    def pad(self):
        t = time.monotonic() - self.t0
        bits = [BTN_A, BTN_B, BTN_X, BTN_Y, BTN_LB, BTN_RB, DPAD_UP, DPAD_RIGHT, BTN_GUIDE, BTN_MENU]
        b = bits[int(t * 2) % len(bits)]
        return PadState(b, (math.sin(t) + 1) / 2, (math.cos(t) + 1) / 2,
                        math.cos(t * 2), math.sin(t * 2), math.sin(t * 1.3), math.cos(t * 0.7))

    def key_down(self, vk):
        t = time.monotonic() - self.t0
        demo = [0x57, 0x41, 0x53, 0x44, 0x20, 0xA0, 0x01, 0x02, 0x45]
        return vk == demo[int(t * 3) % len(demo)] or (vk == 0x57 and int(t) % 2 == 0)

    def vk_from_scancode(self, sc):
        return SCAN_FALLBACK_VK.get(sc, 0)

    def char_for_vk(self, vk):
        return chr(vk) if 0x30 <= vk <= 0x5A else ""


# Fallback (deutsches QWERTZ-Layout), falls nicht unter Windows
SCAN_FALLBACK_VK = {
    0x02: 0x31, 0x03: 0x32, 0x04: 0x33, 0x05: 0x34, 0x06: 0x35, 0x07: 0x36,
    0x10: 0x51, 0x11: 0x57, 0x12: 0x45, 0x13: 0x52, 0x14: 0x54, 0x15: 0x5A,
    0x1E: 0x41, 0x1F: 0x53, 0x20: 0x44, 0x21: 0x46, 0x22: 0x47, 0x23: 0x48,
    0x2C: 0x59, 0x2D: 0x58, 0x2E: 0x43, 0x2F: 0x56, 0x30: 0x42,
}

VK_SHIFT, VK_CONTROL, VK_MENU = 0x10, 0x11, 0x12
VK_LSHIFT, VK_LCONTROL, VK_LMENU, VK_LWIN = 0xA0, 0xA2, 0xA4, 0x5B
VK_SPACE, VK_TAB, VK_ESC, VK_CAPS = 0x20, 0x09, 0x1B, 0x14

# Tastaturlayout: (Scancode oder ("vk", VK, Label), Breite in Tasteneinheiten)
KEY_ROWS = [
    [(("vk", VK_ESC, "Esc"), 1), (0x02, 1), (0x03, 1), (0x04, 1), (0x05, 1), (0x06, 1), (0x07, 1)],
    [(("vk", VK_TAB, "Tab"), 1.5), (0x10, 1), (0x11, 1), (0x12, 1), (0x13, 1), (0x14, 1), (0x15, 1)],
    [(("vk", VK_CAPS, "Caps"), 1.75), (0x1E, 1), (0x1F, 1), (0x20, 1), (0x21, 1), (0x22, 1), (0x23, 1)],
    [(("vk", VK_LSHIFT, "Shift"), 2.25), (0x2C, 1), (0x2D, 1), (0x2E, 1), (0x2F, 1), (0x30, 1)],
    [(("vk", VK_LCONTROL, "Strg"), 1.5), (("vk", VK_LWIN, "Win"), 1.25),
     (("vk", VK_LMENU, "Alt"), 1.25), (("vk", VK_SPACE, "Leertaste"), 3.75)],
]
MOUSE_BUTTONS = {"lmb": 0x01, "rmb": 0x02, "mmb": 0x04, "x1": 0x05, "x2": 0x06}


# --------------------------------------------------------------------------
# Zeichenhilfen
# --------------------------------------------------------------------------
def rrect(c, x1, y1, x2, y2, r, **kw):
    r = min(r, (x2 - x1) / 2, (y2 - y1) / 2)
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
           x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return c.create_polygon(pts, smooth=True, **kw)


def circle(c, x, y, r, **kw):
    return c.create_oval(x - r, y - r, x + r, y + r, **kw)


# --- Farben Controller (weißer Series-S-Controller) ---
BODY = "#f1f1ef"
BODY_EDGE = "#a9aaa8"
BODY_SHADE = "#dcdcd9"
PART = "#e6e6e3"          # Buttons / Sticks (weiß-grau)
PART_EDGE = "#8f908e"
DARK = "#2a2b2d"
GLOW = "#ffffff"
ABXY = {"A": "#45b649", "B": "#e2343a", "X": "#2c78d6", "Y": "#f0b400"}
ACCENT = "#24a0ff"

# --- Farben Tastatur ---
KEY_FILL = "#202226"
KEY_EDGE = "#4b4f57"
KEY_TEXT = "#d8dbe0"
KEY_ON_FILL = "#24a0ff"
KEY_ON_EDGE = "#9fd4ff"
KEY_ON_TEXT = "#ffffff"


class ControllerView:
    W, H = 360, 250

    def __init__(self, canvas, s):
        self.c, self.s = canvas, s
        self.items = {}
        self._last = None
        self.build()

    def p(self, *vals):
        return [v * self.s for v in vals]

    def build(self):
        c, s = self.c, self.s
        P = self.p

        # Trigger
        for name, x1, x2 in (("lt", 78, 132), ("rt", 228, 282)):
            rrect(c, *P(x1, 4, x2, 25), 8 * s, fill=PART, outline=PART_EDGE, width=max(1, s * 1.2))
            fill = c.create_rectangle(*P(x1 + 3, 22, x2 - 3, 22), fill=ACCENT, width=0)
            c.create_text(*P((x1 + x2) / 2, 14.5), text=name.upper(), fill=DARK,
                          font=("Segoe UI", int(-9 * s), "bold"))
            self.items[name] = (fill, x1 + 3, x2 - 3)

        # Bumper
        for name, x1, x2 in (("lb", 56, 144), ("rb", 216, 304)):
            item = rrect(c, *P(x1, 28, x2, 44), 8 * s, fill=PART, outline=PART_EDGE,
                         width=max(1, s * 1.2))
            txt = c.create_text(*P((x1 + x2) / 2, 36), text=name.upper(), fill=DARK,
                                font=("Segoe UI", int(-9 * s), "bold"))
            self.items[name] = (item, txt)

        # Körper
        body = [100, 50, 140, 44, 180, 47, 220, 44, 260, 50, 300, 58, 326, 88, 344, 148, 358, 204,
                352, 238, 326, 248, 300, 236, 274, 204, 244, 180, 180, 174, 116, 180, 86, 204, 60, 236,
                34, 248, 8, 238, 2, 204, 16, 148, 34, 88, 60, 58]
        c.create_polygon(*P(*[v + (1.5 if i % 2 else 0) for i, v in enumerate(body)]),
                         smooth=True, fill=BODY_SHADE, outline="")
        c.create_polygon(*P(*body), smooth=True, fill=BODY, outline=BODY_EDGE, width=max(1, s * 1.5))

        # Xbox-Button
        g = circle(c, *P(180, 80), 13 * s, fill=PART, outline=PART_EDGE, width=max(1, s))
        gx = c.create_text(*P(180, 80), text="X", fill=DARK, font=("Segoe UI", int(-12 * s), "bold"))
        self.items["guide"] = (g, gx)

        # View / Menu / Share
        self.items["view"] = (circle(c, *P(152, 112), 6.5 * s, fill=PART, outline=PART_EDGE, width=max(1, s)),)
        self.items["menu"] = (circle(c, *P(208, 112), 6.5 * s, fill=PART, outline=PART_EDGE, width=max(1, s)),)
        circle(c, *P(180, 129), 4 * s, fill=PART, outline=PART_EDGE, width=max(1, s))
        c.create_line(*P(149, 110.5, 155, 110.5), fill=DARK, width=max(1, s))
        c.create_line(*P(149, 113.5, 155, 113.5), fill=DARK, width=max(1, s))
        for dy in (-2.2, 0, 2.2):
            c.create_line(*P(205, 112 + dy, 211, 112 + dy), fill=DARK, width=max(1, s * 0.8))

        # Sticks
        for name, cx, cy in (("ls", 98, 112), ("rs", 222, 166)):
            circle(c, *P(cx, cy), 22 * s, fill=BODY_SHADE, outline=PART_EDGE, width=max(1, s * 1.2))
            thumb = circle(c, *P(cx, cy), 14 * s, fill=PART, outline=PART_EDGE, width=max(1, s * 1.5))
            dot = circle(c, *P(cx, cy), 3 * s, fill=PART_EDGE, outline="")
            self.items[name] = (thumb, dot, cx, cy)

        # D-Pad
        cx, cy = 138, 166
        circle(c, *P(cx, cy), 20 * s, fill=BODY_SHADE, outline="")
        arms = {
            "up": (cx - 6, cy - 17, cx + 6, cy - 5),
            "down": (cx - 6, cy + 5, cx + 6, cy + 17),
            "left": (cx - 17, cy - 6, cx - 5, cy + 6),
            "right": (cx + 5, cy - 6, cx + 17, cy + 6),
        }
        c.create_rectangle(*P(cx - 6, cy - 6, cx + 6, cy + 6), fill=PART, outline=PART_EDGE,
                           width=max(1, s))
        for name, box in arms.items():
            self.items["d" + name] = (rrect(c, *P(*box), 3 * s, fill=PART, outline=PART_EDGE,
                                            width=max(1, s)),)

        # ABXY
        bx, by, d = 262, 112, 20
        for name, ox, oy in (("Y", 0, -d), ("X", -d, 0), ("B", d, 0), ("A", 0, d)):
            o = circle(c, *P(bx + ox, by + oy), 10.5 * s, fill=PART, outline=PART_EDGE,
                       width=max(1, s * 1.2))
            t = c.create_text(*P(bx + ox, by + oy), text=name, fill=ABXY[name],
                              font=("Segoe UI", int(-11 * s), "bold"))
            self.items[name] = (o, t)

    def update(self, st):
        k = st.key() if st else None
        if k == self._last:
            return
        self._last = k
        st = st or PadState()
        c, s = self.c, self.s
        b = st.buttons

        def simple(name, on):
            c.itemconfigure(self.items[name][0], fill=ACCENT if on else PART,
                            outline=DARK if on else PART_EDGE)

        for name, val in (("lt", st.lt), ("rt", st.rt)):
            item, x1, x2 = self.items[name]
            top = 22 - 15 * val
            c.coords(item, *self.p(x1, top, x2, 22))
        for name, bit in (("lb", BTN_LB), ("rb", BTN_RB)):
            on = bool(b & bit)
            simple(name, on)
            c.itemconfigure(self.items[name][1], fill=GLOW if on else DARK)
        g, gx = self.items["guide"]
        on = bool(b & BTN_GUIDE)
        c.itemconfigure(g, fill=GLOW if on else PART, outline=ACCENT if on else PART_EDGE,
                        width=max(1, s * (3 if on else 1)))
        simple("view", b & BTN_VIEW)
        simple("menu", b & BTN_MENU)
        for name, bit in (("dup", DPAD_UP), ("ddown", DPAD_DOWN), ("dleft", DPAD_LEFT), ("dright", DPAD_RIGHT)):
            simple(name, b & bit)
        for name, bit in (("A", BTN_A), ("B", BTN_B), ("X", BTN_X), ("Y", BTN_Y)):
            o, t = self.items[name]
            on = bool(b & bit)
            c.itemconfigure(o, fill=ABXY[name] if on else PART, outline=DARK if on else PART_EDGE)
            c.itemconfigure(t, fill=GLOW if on else ABXY[name])
        for name, x, y, bit in (("ls", st.lx, st.ly, BTN_LS), ("rs", st.rx, st.ry, BTN_RS)):
            thumb, dot, cx, cy = self.items[name]
            tx, ty = cx + x * 9, cy - y * 9
            c.coords(thumb, *self.p(tx - 14, ty - 14, tx + 14, ty + 14))
            c.coords(dot, *self.p(tx - 3, ty - 3, tx + 3, ty + 3))
            on = bool(b & bit)
            c.itemconfigure(thumb, fill=ACCENT if on else PART, outline=DARK if on else PART_EDGE)
            c.itemconfigure(dot, fill=GLOW if on else PART_EDGE)


class KeyboardView:
    U = 36      # Tasteneinheit
    GAP = 4

    def __init__(self, canvas, s, inp):
        self.c, self.s, self.inp = canvas, s, inp
        self.keys = []   # (vk, rect, text)
        self.mouse = {}
        self._last = None
        self.build()
        self.W = self._w
        self.H = self._h

    def build(self):
        c, s, U, G = self.c, self.s, self.U, self.GAP
        pad = 4
        y = pad
        maxx = 0
        for row in KEY_ROWS:
            x = pad
            for spec, width in row:
                if isinstance(spec, tuple):
                    _, vk, label = spec
                else:
                    vk = self.inp.vk_from_scancode(spec) or SCAN_FALLBACK_VK.get(spec, 0)
                    label = self.inp.char_for_vk(vk) or "?"
                w = width * U - G
                r = rrect(c, x * s, y * s, (x + w) * s, (y + U - G) * s, 7 * s,
                          fill=KEY_FILL, outline=KEY_EDGE, width=max(1, s * 1.2))
                size = -13 if len(label) <= 2 else -10
                t = c.create_text((x + w / 2) * s, (y + (U - G) / 2) * s, text=label, fill=KEY_TEXT,
                                  font=("Segoe UI", int(size * s), "bold"))
                self.keys.append((vk, r, t))
                x += width * U
            maxx = max(maxx, x)
            y += U
        # Maus
        mx1 = maxx + 14
        mw = 2.4 * U
        mx2 = mx1 + mw
        my1, my2 = pad + U * 0.5, y - G
        mid = (mx1 + mx2) / 2
        split = my1 + (my2 - my1) * 0.42
        rrect(c, mx1 * s, my1 * s, mx2 * s, my2 * s, 30 * s, fill=KEY_FILL, outline=KEY_EDGE,
              width=max(1, s * 1.2))
        self.mouse["lmb"] = rrect(c, (mx1 + 3) * s, (my1 + 3) * s, (mid - 7) * s, split * s, 22 * s,
                                  fill=KEY_FILL, outline=KEY_EDGE, width=max(1, s * 1.2))
        self.mouse["rmb"] = rrect(c, (mid + 7) * s, (my1 + 3) * s, (mx2 - 3) * s, split * s, 22 * s,
                                  fill=KEY_FILL, outline=KEY_EDGE, width=max(1, s * 1.2))
        wh = (split - my1)
        self.mouse["mmb"] = rrect(c, (mid - 4) * s, (my1 + wh * 0.22) * s, (mid + 4) * s,
                                  (my1 + wh * 0.72) * s, 5 * s, fill="#3a3d44", outline=KEY_EDGE,
                                  width=max(1, s))
        sy = split + 10
        self.mouse["x2"] = rrect(c, (mx1 - 6) * s, sy * s, (mx1 + 4) * s, (sy + 18) * s, 3 * s,
                                 fill=KEY_FILL, outline=KEY_EDGE, width=max(1, s))
        self.mouse["x1"] = rrect(c, (mx1 - 6) * s, (sy + 22) * s, (mx1 + 4) * s, (sy + 40) * s, 3 * s,
                                 fill=KEY_FILL, outline=KEY_EDGE, width=max(1, s))
        self._w = mx2 + pad
        self._h = y + pad - G

    def update(self, down):
        k = frozenset(down)
        if k == self._last:
            return
        self._last = k
        c = self.c
        for vk, r, t in self.keys:
            on = vk in down
            c.itemconfigure(r, fill=KEY_ON_FILL if on else KEY_FILL, outline=KEY_ON_EDGE if on else KEY_EDGE)
            c.itemconfigure(t, fill=KEY_ON_TEXT if on else KEY_TEXT)
        for name, item in self.mouse.items():
            on = MOUSE_BUTTONS[name] in down
            base = "#3a3d44" if name == "mmb" else KEY_FILL
            c.itemconfigure(item, fill=KEY_ON_FILL if on else base, outline=KEY_ON_EDGE if on else KEY_EDGE)

    def watched_vks(self):
        return [vk for vk, _, _ in self.keys] + list(MOUSE_BUTTONS.values())


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------
class App:
    def __init__(self):
        if IS_WINDOWS:
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception:
                pass
        self.inp = WinInput() if (IS_WINDOWS and not DEMO) else DemoInput()
        self.cfg = load_settings()
        self.shown_mode = "controller" if self.cfg["mode"] != "keyboard" else "keyboard"
        self.view = None
        self._hk_prev = {}
        self._drag = None
        self._save_job = None
        self._last_topmost = 0.0

        # --- Steuerfenster ---
        self.root = tk.Tk()
        self.root.title("Input Overlay")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.quit)
        self._build_panel()

        # --- Overlay ---
        self.ov = tk.Toplevel(self.root)
        self.ov.overrideredirect(True)
        self.ov.attributes("-topmost", True)
        self.ov.configure(bg=KEY_COLOR)
        if IS_WINDOWS:
            self.ov.attributes("-transparentcolor", KEY_COLOR)
        self.canvas = tk.Canvas(self.ov, bg=KEY_COLOR, highlightthickness=0, bd=0)
        self.canvas.pack()
        self.canvas.bind("<ButtonPress-1>", self._drag_start)
        self.canvas.bind("<B1-Motion>", self._drag_move)
        self.canvas.bind("<ButtonRelease-1>", lambda e: self.schedule_save())
        self.canvas.bind("<Button-3>", self._context_menu)
        self.canvas.bind("<MouseWheel>", lambda e: self.change_scale(0.1 if e.delta > 0 else -0.1))
        self.canvas.bind("<Button-4>", lambda e: self.change_scale(0.1))
        self.canvas.bind("<Button-5>", lambda e: self.change_scale(-0.1))

        self.rebuild()
        self.apply_opacity()
        self.apply_visibility()
        self.ov.after(200, self.apply_lock)
        self.tick()

    # ---------------- Panel ----------------
    def _build_panel(self):
        r = self.root
        f = ttk.Frame(r, padding=14)
        f.pack(fill="both", expand=True)

        ttk.Label(f, text="Input Overlay", font=("Segoe UI", 14, "bold")).pack(anchor="w")
        ttk.Label(f, text="Zeigt deine Eingaben über dem Spiel an.").pack(anchor="w", pady=(0, 10))

        mf = ttk.LabelFrame(f, text="Was soll angezeigt werden?", padding=8)
        mf.pack(fill="x")
        self.var_mode = tk.StringVar(value=self.cfg["mode"])
        for m in MODES:
            label = MODE_NAMES[m]
            if m == "auto":
                label += "  (wechselt je nachdem, was du benutzt)"
            ttk.Radiobutton(mf, text=label, value=m, variable=self.var_mode,
                            command=lambda: self.set_mode(self.var_mode.get())).pack(anchor="w")

        of = ttk.LabelFrame(f, text="Overlay", padding=8)
        of.pack(fill="x", pady=(10, 0))
        self.var_visible = tk.BooleanVar(value=self.cfg["visible"])
        ttk.Checkbutton(of, text="Overlay anzeigen  (Strg+Alt+O)", variable=self.var_visible,
                        command=lambda: self.set_visible(self.var_visible.get())).pack(anchor="w")
        self.var_locked = tk.BooleanVar(value=self.cfg["locked"])
        ttk.Checkbutton(of, text="Fixieren – Mausklicks gehen durch  (Strg+Alt+L)",
                        variable=self.var_locked,
                        command=lambda: self.set_locked(self.var_locked.get())).pack(anchor="w")

        ttk.Label(of, text="Größe").pack(anchor="w", pady=(8, 0))
        row = ttk.Frame(of)
        row.pack(fill="x")
        self.var_scale = tk.DoubleVar(value=self.cfg["scale"] * 100)
        self.lbl_scale = ttk.Label(row, width=6)
        ttk.Scale(row, from_=MIN_SCALE * 100, to=MAX_SCALE * 100, variable=self.var_scale,
                  command=lambda v: self.set_scale(float(v) / 100, from_panel=True)).pack(
            side="left", fill="x", expand=True)
        self.lbl_scale.pack(side="left", padx=(8, 0))

        ttk.Label(of, text="Deckkraft").pack(anchor="w", pady=(6, 0))
        row = ttk.Frame(of)
        row.pack(fill="x")
        self.var_opacity = tk.DoubleVar(value=self.cfg["opacity"] * 100)
        self.lbl_opacity = ttk.Label(row, width=6)
        ttk.Scale(row, from_=20, to=100, variable=self.var_opacity,
                  command=lambda v: self.set_opacity(float(v) / 100)).pack(side="left", fill="x", expand=True)
        self.lbl_opacity.pack(side="left", padx=(8, 0))

        ttk.Button(of, text="Position zurücksetzen", command=self.reset_position).pack(anchor="w", pady=(8, 0))

        self.lbl_status = ttk.Label(f, text="", foreground="#666")
        self.lbl_status.pack(anchor="w", pady=(10, 0))

        hk = ("Tastenkürzel (funktionieren auch im Spiel):\n"
              "  Strg+Alt+O   Overlay ein/aus\n"
              "  Strg+Alt+M   Controller / Tastatur / Automatisch\n"
              "  Strg+Alt+ +/−   größer / kleiner\n"
              "  Strg+Alt+L   fixieren / lösen\n"
              "Overlay verschieben: mit linker Maustaste ziehen\n"
              "Größe: Mausrad über dem Overlay · Rechtsklick: Menü")
        ttk.Label(f, text=hk, justify="left", foreground="#444").pack(anchor="w", pady=(8, 0))

        bf = ttk.Frame(f)
        bf.pack(fill="x", pady=(12, 0))
        ttk.Button(bf, text="Minimieren", command=self.root.iconify).pack(side="left")
        ttk.Button(bf, text="Beenden", command=self.quit).pack(side="right")
        self._refresh_labels()

    def _refresh_labels(self):
        self.lbl_scale.configure(text=f"{round(self.cfg['scale'] * 100)} %")
        self.lbl_opacity.configure(text=f"{round(self.cfg['opacity'] * 100)} %")

    # ---------------- Aktionen ----------------
    def set_mode(self, mode):
        self.cfg["mode"] = mode
        self.var_mode.set(mode)
        if mode != "auto" and mode != self.shown_mode:
            self.shown_mode = mode
            self.rebuild()
        self.schedule_save()

    def cycle_mode(self):
        self.set_mode(MODES[(MODES.index(self.cfg["mode"]) + 1) % len(MODES)])

    def set_visible(self, v):
        self.cfg["visible"] = bool(v)
        self.var_visible.set(bool(v))
        self.apply_visibility()
        self.schedule_save()

    def apply_visibility(self):
        if self.cfg["visible"]:
            self.ov.deiconify()
            self.ov.attributes("-topmost", True)
            self.ov.after(50, self.apply_lock)
        else:
            self.ov.withdraw()

    def set_locked(self, v):
        self.cfg["locked"] = bool(v)
        self.var_locked.set(bool(v))
        self.apply_lock()
        self.schedule_save()

    def apply_lock(self):
        if not IS_WINDOWS:
            return
        try:
            import ctypes
            u = ctypes.windll.user32
            u.GetParent.restype = ctypes.c_void_p
            u.GetParent.argtypes = [ctypes.c_void_p]
            hwnd = u.GetParent(self.ov.winfo_id()) or self.ov.winfo_id()
            GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT = -20, 0x80000, 0x20
            u.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
            u.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
            style = u.GetWindowLongW(hwnd, GWL_EXSTYLE) | WS_EX_LAYERED
            if self.cfg["locked"]:
                style |= WS_EX_TRANSPARENT
            else:
                style &= ~WS_EX_TRANSPARENT
            u.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        except Exception:
            pass

    def set_scale(self, scale, from_panel=False):
        scale = round(max(MIN_SCALE, min(MAX_SCALE, scale)), 2)
        if abs(scale - self.cfg["scale"]) < 0.005:
            return
        self.cfg["scale"] = scale
        if not from_panel:
            self.var_scale.set(scale * 100)
        self._refresh_labels()
        self.rebuild()
        self.schedule_save()

    def change_scale(self, delta):
        self.set_scale(self.cfg["scale"] + delta)

    def set_opacity(self, o):
        self.cfg["opacity"] = max(0.2, min(1.0, o))
        self._refresh_labels()
        self.apply_opacity()
        self.schedule_save()

    def apply_opacity(self):
        try:
            self.ov.attributes("-alpha", self.cfg["opacity"])
        except tk.TclError:
            pass
        self.ov.after(30, self.apply_lock)

    def reset_position(self):
        self.cfg["x"], self.cfg["y"] = 60, 60
        self._place()
        self.schedule_save()

    def rebuild(self):
        self.canvas.delete("all")
        s = self.cfg["scale"]
        if self.shown_mode == "controller":
            self.view = ControllerView(self.canvas, s)
            w, h = ControllerView.W * s, ControllerView.H * s
        else:
            self.view = KeyboardView(self.canvas, s, self.inp)
            w, h = self.view.W * s, self.view.H * s
        self.canvas.configure(width=int(w) + 2, height=int(h) + 2)
        self._size = (int(w) + 2, int(h) + 2)
        self._place()

    def _place(self):
        w, h = self._size
        self.ov.geometry(f"{w}x{h}+{int(self.cfg['x'])}+{int(self.cfg['y'])}")

    def schedule_save(self):
        if self._save_job:
            self.root.after_cancel(self._save_job)
        self._save_job = self.root.after(600, lambda: save_settings(self.cfg))

    def quit(self):
        save_settings(self.cfg)
        self.root.destroy()

    # ---------------- Maus ----------------
    def _drag_start(self, e):
        self._drag = (e.x_root - self.ov.winfo_x(), e.y_root - self.ov.winfo_y())

    def _drag_move(self, e):
        if not self._drag:
            return
        self.cfg["x"] = e.x_root - self._drag[0]
        self.cfg["y"] = e.y_root - self._drag[1]
        self.ov.geometry(f"+{int(self.cfg['x'])}+{int(self.cfg['y'])}")

    def _context_menu(self, e):
        m = tk.Menu(self.ov, tearoff=0)
        for mode in MODES:
            m.add_radiobutton(label=MODE_NAMES[mode], value=mode, variable=self.var_mode,
                              command=lambda mo=mode: self.set_mode(mo))
        m.add_separator()
        m.add_command(label="Größer  (Strg+Alt+ +)", command=lambda: self.change_scale(0.1))
        m.add_command(label="Kleiner  (Strg+Alt+ −)", command=lambda: self.change_scale(-0.1))
        m.add_checkbutton(label="Fixieren (Klicks gehen durch)", variable=self.var_locked,
                          command=lambda: self.set_locked(self.var_locked.get()))
        m.add_command(label="Ausblenden  (Strg+Alt+O)", command=lambda: self.set_visible(False))
        m.add_separator()
        m.add_command(label="Einstellungen öffnen", command=self.show_panel)
        m.add_command(label="Beenden", command=self.quit)
        m.tk_popup(e.x_root, e.y_root)

    def show_panel(self):
        self.root.deiconify()
        self.root.lift()

    # ---------------- Hauptschleife ----------------
    def _hotkey(self, name, pressed):
        prev = self._hk_prev.get(name, False)
        self._hk_prev[name] = pressed
        return pressed and not prev

    def _poll_hotkeys(self):
        d = self.inp.key_down
        if DEMO:
            return
        mod = d(VK_CONTROL) and d(VK_MENU)
        if self._hotkey("o", mod and d(0x4F)):
            self.set_visible(not self.cfg["visible"])
        if self._hotkey("m", mod and d(0x4D)):
            self.cycle_mode()
        if self._hotkey("l", mod and d(0x4C)):
            self.set_locked(not self.cfg["locked"])
        if self._hotkey("plus", mod and (d(0xBB) or d(0x6B))):
            self.change_scale(0.1)
        if self._hotkey("minus", mod and (d(0xBD) or d(0x6D))):
            self.change_scale(-0.1)

    def tick(self):
        try:
            self._poll_hotkeys()
            pad = self.inp.pad()
            down = set()
            need_keys = self.shown_mode == "keyboard" or self.cfg["mode"] == "auto"
            if need_keys:
                vks = (self.view.watched_vks() if isinstance(self.view, KeyboardView)
                       else [0x57, 0x41, 0x53, 0x44, VK_SPACE, VK_LSHIFT, 0x01, 0x02])
                down = {vk for vk in vks if self.inp.key_down(vk)}

            if self.cfg["mode"] == "auto":
                want = None
                if pad is not None and pad.active():
                    want = "controller"
                elif down:
                    want = "keyboard"
                if want and want != self.shown_mode:
                    self.shown_mode = want
                    self.rebuild()

            if self.cfg["visible"]:
                if isinstance(self.view, ControllerView):
                    self.view.update(pad)
                else:
                    self.view.update(down)
                now = time.monotonic()
                if now - self._last_topmost > 2.0:   # Spiele schieben sich gern davor
                    self._last_topmost = now
                    self.ov.attributes("-topmost", True)
                    self.ov.lift()

            slot = getattr(self.inp, "slot", None)
            status = (f"Controller: verbunden (Slot {slot + 1})" if pad is not None and slot is not None
                      else "Controller: nicht gefunden – per USB oder Bluetooth verbinden")
            if self.lbl_status.cget("text") != status:
                self.lbl_status.configure(text=status)
        except tk.TclError:
            return
        self.root.after(16, self.tick)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    App().run()
