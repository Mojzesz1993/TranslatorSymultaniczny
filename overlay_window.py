#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
overlay_window.py
Przezroczysta nakładka Windows Always-On-Top (Click-Through) wyświetlająca napisy tłumaczenia
bezpośrednio nad natywnym pokazem slajdów Microsoft PowerPoint na wybranym monitorze.
"""

import argparse
import ctypes
import json
import os
import tkinter as tk
import urllib.request

from presentation_manager import get_windows_monitors

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010


def _make_window_click_through(hwnd):
    if os.name != "nt":
        return
    try:
        user32 = ctypes.windll.user32
        style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        style |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    except Exception:
        pass


def _fetch_json(url):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=1.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


class SubtitleOverlayApp:
    def __init__(self, port=8765, monitor_index=0):
        self.port = port
        self.monitor_index = monitor_index
        self.last_sig = None

        monitors = get_windows_monitors()
        mon = monitors[monitor_index] if 0 <= monitor_index < len(monitors) else monitors[0]
        self.mon = mon

        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.bg_key = "#010203"
        self.root.configure(bg=self.bg_key)
        if os.name == "nt":
            self.root.attributes("-transparentcolor", self.bg_key)

        self.bar_height = max(120, int(mon["height"] * 0.16))
        self.bar_width = int(mon["width"] * 0.88)
        self.pos_x = mon["left"] + (mon["width"] - self.bar_width) // 2
        self.pos_y_bottom = mon["top"] + mon["height"] - self.bar_height - int(mon["height"] * 0.03)
        self.pos_y_top = mon["top"] + int(mon["height"] * 0.03)

        self.root.geometry(f"{self.bar_width}x{self.bar_height}+{self.pos_x}+{self.pos_y_bottom}")

        self.card = tk.Frame(self.root, bg="#080D1B", highlightbackground="#334155", highlightthickness=1)
        self.card.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        self.lbl_speaker = tk.Label(
            self.card,
            text="",
            fg="#38BDF8",
            bg="#080D1B",
            font=("Segoe UI", 12, "bold"),
            anchor="center",
        )
        self.lbl_speaker.pack(fill=tk.X, padx=16, pady=(6, 0))

        self.lbl_en = tk.Label(
            self.card,
            text="",
            fg="#FFFFFF",
            bg="#080D1B",
            font=("Segoe UI", 26, "bold"),
            wraplength=self.bar_width - 60,
            justify="center",
        )
        self.lbl_en.pack(fill=tk.BOTH, expand=True, padx=24, pady=(2, 8))

        self.root.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id()) if os.name == "nt" else 0
        if hwnd:
            _make_window_click_through(hwnd)
        else:
            _make_window_click_through(self.root.winfo_id())

        self.root.after(150, self._poll)

    def _poll(self):
        try:
            state_resp = _fetch_json(f"http://127.0.0.1:{self.port}/api/state")
            pres_resp = _fetch_json(f"http://127.0.0.1:{self.port}/api/presentation")
        except Exception:
            self.root.after(350, self._poll)
            return

        payload = state_resp.get("payload") or {}
        live = payload.get("liveState") or {}
        settings = payload.get("settings") or {}
        items = live.get("items") or []

        hide_subs = bool(pres_resp.get("hideSubtitles")) or bool(live.get("blackout"))
        pos_mode = pres_resp.get("subtitlePosition") or "bottom"
        font_scale = float(pres_resp.get("subtitleFontScale") or 0.85)
        opacity = float(pres_resp.get("subtitleOpacity") or 0.88)

        last_item = items[-1] if items else None
        en_text = (last_item.get("en") or "").strip() if last_item else ""
        speaker = (last_item.get("speaker") or "").strip() if last_item else ""

        if hide_subs or not en_text:
            if self.last_sig != "HIDDEN":
                self.root.withdraw()
                self.last_sig = "HIDDEN"
        else:
            sig = f"{pos_mode}|{font_scale:.2f}|{opacity:.2f}|{speaker}|{en_text}"
            if sig != self.last_sig:
                self.last_sig = sig
                self.root.deiconify()
                y = self.pos_y_top if pos_mode == "top" else self.pos_y_bottom
                self.root.geometry(f"{self.bar_width}x{self.bar_height}+{self.pos_x}+{y}")
                try:
                    self.root.attributes("-alpha", max(0.35, min(0.98, opacity + 0.15)))
                except Exception:
                    pass

                font_px = max(16, int(28 * font_scale))
                self.lbl_en.configure(text=en_text, font=("Segoe UI", font_px, "bold"))
                if speaker and settings.get("showSpeakerBadge", True):
                    self.lbl_speaker.configure(text=speaker.upper())
                    self.lbl_speaker.pack(fill=tk.X, padx=16, pady=(6, 0))
                else:
                    self.lbl_speaker.pack_forget()

                if os.name == "nt":
                    hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id()) or self.root.winfo_id()
                    _make_window_click_through(hwnd)

        self.root.after(200, self._poll)

    def run(self):
        self.root.mainloop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--monitor", type=int, default=0)
    args = parser.parse_args()
    app = SubtitleOverlayApp(port=args.port, monitor_index=args.monitor)
    app.run()


if __name__ == "__main__":
    main()
