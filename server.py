#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lokalny serwer aplikacji Debate Live Translator (PL -> EN).
Zapewnia:
1. Serwowanie głównej aplikacji pod adresem http://localhost:8765 (Operator + Ekran Prezentacji).
2. Dedykowany serwer Panelu Sterowania Prezentacją na porcie http://localhost:8766.
3. Synchronizację stanu, tła oraz slajdów prezentacji pomiędzy wszystkimi oknami.
"""

import json
import os
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from presentation_manager import (
    control_presentation,
    delete_presentation,
    get_presentation_state,
    get_windows_monitors,
    list_presentations,
    load_presentation_meta,
    save_and_convert_presentation,
    select_presentation,
    stop_overlay_process,
)

PORT = 8765
PRESENTER_PORT = 8766
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ACTIVE_MAIN_PORT = PORT
ACTIVE_PRESENTER_PORT = PRESENTER_PORT

# Pamięć podręczna stanu dla synchronizacji między oknami / przeglądarkami
STATE_LOCK = threading.Lock()
CURRENT_STATE = {
    "version": 0,
    "payload": None,
}
BACKGROUND_LOCK = threading.Lock()
CURRENT_BACKGROUND = {
    "version": 0,
    "dataUrl": None,
    "mediaType": None,
    "fileName": None,
}


def get_local_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


class BaseTranslatorHandler(SimpleHTTPRequestHandler):
    is_presenter_port = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        if len(args) > 0 and isinstance(args[0], str):
            quiet_paths = ("/api/state", "/api/background", "/api/voice-embed", "/api/presentation", "/api/monitors")
            if any(p in args[0] for p in quiet_paths) and "upload" not in args[0]:
                return
        super().log_message(format, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-File-Name")
        super().end_headers()

    def _send_json(self, status_code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if self.is_presenter_port and path in ("/", "/index.html"):
            self.path = "/presenter.html"

        if path == "/api/server-info":
            self._send_json(200, {
                "mainPort": ACTIVE_MAIN_PORT,
                "presenterPort": ACTIVE_PRESENTER_PORT,
                "localIp": get_local_lan_ip(),
            })
            return

        if path == "/api/state":
            with STATE_LOCK:
                self._send_json(200, CURRENT_STATE)
            return

        if path == "/api/background":
            with BACKGROUND_LOCK:
                self._send_json(200, CURRENT_BACKGROUND)
            return

        if path == "/api/monitors":
            self._send_json(200, {"ok": True, "monitors": get_windows_monitors()})
            return

        if path == "/api/presentation":
            self._send_json(200, get_presentation_state())
            return

        if path == "/api/presentation/list":
            self._send_json(200, {
                "ok": True,
                "presentations": list_presentations(),
                "state": get_presentation_state(),
            })
            return

        if path == "/api/presentation/detail":
            qs = urllib.parse.parse_qs(parsed.query)
            pres_id = (qs.get("id") or [""])[0]
            meta = load_presentation_meta(pres_id)
            if not meta:
                self._send_json(404, {"ok": False, "error": "Nie znaleziono prezentacji."})
            else:
                self._send_json(200, {"ok": True, "presentation": meta})
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        if path == "/api/state":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                with STATE_LOCK:
                    CURRENT_STATE["version"] += 1
                    CURRENT_STATE["payload"] = body
                    version = CURRENT_STATE["version"]
                self._send_json(200, {"ok": True, "version": version})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/background":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                with BACKGROUND_LOCK:
                    CURRENT_BACKGROUND["version"] += 1
                    CURRENT_BACKGROUND["dataUrl"] = body.get("dataUrl")
                    CURRENT_BACKGROUND["mediaType"] = body.get("mediaType")
                    CURRENT_BACKGROUND["fileName"] = body.get("fileName")
                    version = CURRENT_BACKGROUND["version"]
                self._send_json(200, {"ok": True, "version": version})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/presentation/upload":
            try:
                raw_name = self.headers.get("X-File-Name", "prezentacja.pptx")
                file_name = urllib.parse.unquote(raw_name)
                if not raw_body:
                    raise ValueError("Przesłano pusty plik.")
                meta = save_and_convert_presentation(file_name, raw_body)
                state, _ = select_presentation(meta["id"], activate=True)
                self._send_json(200, {"ok": True, "presentation": meta, "state": state})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/presentation/select":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                pres_id = body.get("id")
                activate = bool(body.get("activate", True))
                state, meta = select_presentation(pres_id, activate=activate)
                self._send_json(200, {"ok": True, "presentation": meta, "state": state})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/presentation/delete":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                delete_presentation(body.get("id") or "")
                self._send_json(200, {"ok": True, "state": get_presentation_state()})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/presentation/control":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                state = control_presentation(body, main_port=ACTIVE_MAIN_PORT)
                self._send_json(200, {"ok": True, "state": state})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/api/translate-fallback":
            try:
                body = json.loads(raw_body.decode("utf-8"))
                text_src = (body.get("text") or "").strip()
                sl = (body.get("sl") or "pl").strip()
                tl = (body.get("tl") or "en").strip()
                if not text_src:
                    self._send_json(200, {"ok": True, "en": ""})
                else:
                    q = urllib.parse.quote(text_src)
                    gtx_url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={urllib.parse.quote(sl)}&tl={urllib.parse.quote(tl)}&dt=t&q={q}"
                    req = urllib.request.Request(gtx_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=4) as r:
                        arr = json.loads(r.read().decode("utf-8"))
                        translated = "".join(part[0] for part in (arr[0] or []) if part and part[0])
                    self._send_json(200, {"ok": True, "en": translated.strip()})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if path == "/api/voice-embed":
            try:
                from neural_voice_id import extract_neural_embedding_from_pcm16_base64
                body = json.loads(raw_body.decode("utf-8"))
                pcm16_b64 = body.get("pcm16Base64") or ""
                if not pcm16_b64:
                    self._send_json(200, {"ok": False, "error": "Brak danych audio"})
                else:
                    result = extract_neural_embedding_from_pcm16_base64(pcm16_b64)
                    self._send_json(200, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        self.send_response(404)
        self.end_headers()


class TranslatorRequestHandler(BaseTranslatorHandler):
    is_presenter_port = False


class PresenterRequestHandler(BaseTranslatorHandler):
    is_presenter_port = True


def find_free_port(preferred_port=8765, exclude=()):
    for port in range(preferred_port, preferred_port + 30):
        if port in exclude:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return preferred_port


def main():
    global ACTIVE_MAIN_PORT, ACTIVE_PRESENTER_PORT
    no_browser = "--no-browser" in sys.argv

    ACTIVE_MAIN_PORT = find_free_port(PORT)
    ACTIVE_PRESENTER_PORT = find_free_port(PRESENTER_PORT, exclude=(ACTIVE_MAIN_PORT,))

    url = f"http://localhost:{ACTIVE_MAIN_PORT}/index.html"
    screen_url = f"http://localhost:{ACTIVE_MAIN_PORT}/screen.html"
    presenter_url = f"http://localhost:{ACTIVE_PRESENTER_PORT}/"
    lan_ip = get_local_lan_ip()

    print("=" * 72)
    print("  DEBATE LIVE TRANSLATOR (PL -> EN) — Lokalny Serwer Aplikacji")
    print("=" * 72)
    print(f"  Panel Operatora      : {url}")
    print(f"  Ekran Prezentacji    : {screen_url}")
    print(f"  Panel Slajdow (PPTX) : {presenter_url}  (w sieci: http://{lan_ip}:{ACTIVE_PRESENTER_PORT})")
    print("-" * 72)
    print("  Wskazowka: Najlepiej uzywac przegladarki Google Chrome lub Edge.")
    print("  Nie zamykaj tego okna podczas trwania debaty (Ctrl+C aby zakonczyc).")
    print("=" * 72)

    def _warmup_voice_model():
        try:
            from neural_voice_id import get_ort_session
            get_ort_session()
        except Exception as e:
            print(f"[Voice-ID AI] Uwaga: {e}")

    threading.Thread(target=_warmup_voice_model, daemon=True).start()

    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    main_server = ThreadingHTTPServer(("0.0.0.0", ACTIVE_MAIN_PORT), TranslatorRequestHandler)
    presenter_server = ThreadingHTTPServer(("0.0.0.0", ACTIVE_PRESENTER_PORT), PresenterRequestHandler)

    presenter_thread = threading.Thread(target=presenter_server.serve_forever, daemon=True)
    presenter_thread.start()

    try:
        main_server.serve_forever()
    except KeyboardInterrupt:
        print("\nZatrzymywanie serwerow...")
        stop_overlay_process()
        presenter_server.shutdown()
        presenter_server.server_close()
        main_server.server_close()


if __name__ == "__main__":
    main()
