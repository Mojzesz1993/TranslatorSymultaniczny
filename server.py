#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lokalny serwer aplikacji Debate Live Translator (PL -> EN).
Zapewnia:
1. Serwowanie aplikacji pod adresem http://localhost:8765 (dzięki czemu Chrome/Edge
   trwale zapamiętuje uprawnienia do mikrofonu i obsługuje Web Speech API bez przerw).
2. Synchronizację stanu oraz tła pomiędzy oknem Operatora a Ekranem Prezentacji
   (również między różnymi przeglądarkami lub urządzeniami w sieci lokalnej).
"""

import json
import os
import sys
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Pamięć podręczna stanu dla synchronizacji między oknami / przeglądarkami
STATE_LOCK = threading.Lock()
CURRENT_STATE = {
    "version": 0,
    "payload": None
}
BACKGROUND_LOCK = threading.Lock()
CURRENT_BACKGROUND = {
    "version": 0,
    "dataUrl": None,
    "mediaType": None,  # 'image' | 'video' | None
    "fileName": None
}


class TranslatorRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        # Wyciszamy ciągłe logi zapytań o stan, logujemy tylko błędy lub ważne akcje
        if len(args) > 0 and isinstance(args[0], str):
            if "/api/state" in args[0] or "/api/background" in args[0] or "/api/voice-embed" in args[0]:
                return
        super().log_message(format, *args)

    def end_headers(self):
        # Wyłączamy cache przeglądarki dla plików lokalnych i włączamy CORS
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/state"):
            with STATE_LOCK:
                data = json.dumps(CURRENT_STATE, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if self.path.startswith("/api/background"):
            with BACKGROUND_LOCK:
                data = json.dumps(CURRENT_BACKGROUND, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        return super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        if self.path.startswith("/api/state"):
            try:
                body = json.loads(raw_body.decode("utf-8"))
                with STATE_LOCK:
                    CURRENT_STATE["version"] += 1
                    CURRENT_STATE["payload"] = body
                    version = CURRENT_STATE["version"]
                resp = json.dumps({"ok": True, "version": version}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(resp)
            return

        if self.path.startswith("/api/background"):
            try:
                body = json.loads(raw_body.decode("utf-8"))
                with BACKGROUND_LOCK:
                    CURRENT_BACKGROUND["version"] += 1
                    CURRENT_BACKGROUND["dataUrl"] = body.get("dataUrl")
                    CURRENT_BACKGROUND["mediaType"] = body.get("mediaType")
                    CURRENT_BACKGROUND["fileName"] = body.get("fileName")
                    version = CURRENT_BACKGROUND["version"]
                resp = json.dumps({"ok": True, "version": version}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(resp)
            return

        if self.path.startswith("/api/translate-fallback"):
            try:
                import urllib.parse
                import urllib.request
                body = json.loads(raw_body.decode("utf-8"))
                text_pl = (body.get("text") or "").strip()
                if not text_pl:
                    resp = json.dumps({"ok": True, "en": ""}).encode("utf-8")
                else:
                    q = urllib.parse.quote(text_pl)
                    gtx_url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=pl&tl=en&dt=t&q={q}"
                    req = urllib.request.Request(gtx_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=4) as r:
                        arr = json.loads(r.read().decode("utf-8"))
                        translated = "".join(part[0] for part in (arr[0] or []) if part and part[0])
                    resp = json.dumps({"ok": True, "en": translated.strip()}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(resp)
            return

        if self.path.startswith("/api/voice-embed"):
            try:
                from neural_voice_id import extract_neural_embedding_from_pcm16_base64
                body = json.loads(raw_body.decode("utf-8"))
                pcm16_b64 = body.get("pcm16Base64") or ""
                if not pcm16_b64:
                    resp = json.dumps({"ok": False, "error": "Brak danych audio"}).encode("utf-8")
                else:
                    result = extract_neural_embedding_from_pcm16_base64(pcm16_b64)
                    resp = json.dumps(result).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
            except Exception as e:
                resp = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(resp)
            return

        self.send_response(404)
        self.end_headers()


def find_free_port(preferred_port=8765):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", preferred_port)) != 0:
            return preferred_port
    # Jeśli port jest już zajęty, sprawdźmy czy to nasz serwer czy użyjmy kolejnego
    for port in range(preferred_port, preferred_port + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return preferred_port


def main():
    no_browser = "--no-browser" in sys.argv
    port = find_free_port(PORT)
    url = f"http://localhost:{port}/index.html"
    screen_url = f"http://localhost:{port}/screen.html"

    print("=" * 68)
    print("  DEBATE LIVE TRANSLATOR (PL -> EN) — Lokalny Serwer Aplikacji")
    print("=" * 68)
    print(f"  Panel Operatora   : {url}")
    print(f"  Ekran Prezentacji : {screen_url}")
    print("-" * 68)
    print("  Wskazówka: Najlepiej używać przeglądarki Google Chrome lub Edge.")
    print("  Nie zamykaj tego okna podczas trwania debaty (Ctrl+C aby zakończyć).")
    print("=" * 68)

    # Wstępne załadowanie modelu neuronowego WeSpeaker CAM++ ONNX w tle
    def _warmup_voice_model():
        try:
            from neural_voice_id import get_ort_session
            get_ort_session()
        except Exception as e:
            print(f"[Voice-ID AI] Uwaga: {e}")

    threading.Thread(target=_warmup_voice_model, daemon=True).start()

    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    server = ThreadingHTTPServer(("0.0.0.0", port), TranslatorRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nZatrzymywanie serwera...")
        server.server_close()


if __name__ == "__main__":
    main()
