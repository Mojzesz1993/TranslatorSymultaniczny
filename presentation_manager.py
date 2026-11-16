#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
presentation_manager.py
Moduł zarządzania prezentacjami (PPTX / PPT / PDF / obrazy), konwersji slajdów,
ekstrakcji tekstu/notatek prelegenta dla Gemini oraz sterowania natywnym PowerPointem
i przezroczystą nakładką Always-On-Top.
"""

import ctypes
from ctypes import wintypes
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PRESENTATIONS_DIR = os.path.join(BASE_DIR, "presentations")
os.makedirs(PRESENTATIONS_DIR, exist_ok=True)

PRES_LOCK = threading.Lock()
OVERLAY_PROC = None

PRESENTATION_STATE = {
    "version": 0,
    "active": False,
    "mode": "browser",  # 'browser' | 'native'
    "presentationId": None,
    "title": "",
    "fileType": "",
    "currentSlide": 1,
    "totalSlides": 0,
    "blackoutSlide": False,
    "hideSubtitles": False,
    "subtitlePosition": "bottom",  # 'bottom' | 'top' | 'center'
    "subtitleOpacity": 0.78,
    "subtitleFontScale": 0.85,
    "currentSlideUrl": None,
    "nextSlideUrl": None,
    "currentSlideText": "",
    "currentSpeakerNotes": "",
    "nativeOverlayActive": False,
    "nativeMonitorIndex": 0,
}


def get_windows_monitors():
    """Zwraca listę monitorów Windows [{index, name, left, top, width, height, primary}]."""
    if os.name != "nt":
        return [{"index": 0, "name": "Ekran główny", "left": 0, "top": 0, "width": 1920, "height": 1080, "primary": True}]

    monitors = []

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
            ("szDevice", wintypes.WCHAR * 32),
        ]

    MonitorEnumProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )

    def _callback(hMonitor, hdcMonitor, lprcMonitor, dwData):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if ctypes.windll.user32.GetMonitorInfoW(hMonitor, ctypes.byref(info)):
            r = info.rcMonitor
            idx = len(monitors)
            is_primary = bool(info.dwFlags & 1)
            w = r.right - r.left
            h = r.bottom - r.top
            label = f"Monitor {idx + 1} ({w}x{h})" + (" [Główny]" if is_primary else " [Zewnętrzny / Rzutnik]")
            monitors.append({
                "index": idx,
                "name": label,
                "left": r.left,
                "top": r.top,
                "width": w,
                "height": h,
                "primary": is_primary,
            })
        return True

    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

    ctypes.windll.user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_callback), 0)
    if not monitors:
        monitors.append({"index": 0, "name": "Monitor 1", "left": 0, "top": 0, "width": 1920, "height": 1080, "primary": True})
    return monitors


def _natural_slide_num(filename):
    m = re.search(r"(\d+)", os.path.basename(filename))
    return int(m.group(1)) if m else 0


def _extract_xml_text(xml_bytes):
    """Wyciąga cały czytelny tekst z pliku XML slajdu lub notatek PPTX."""
    try:
        root = ET.fromstring(xml_bytes)
        texts = []
        for elem in root.iter():
            if elem.tag.endswith("}t") and elem.text:
                t = elem.text.strip()
                if t:
                    texts.append(t)
        return " ".join(texts)
    except Exception:
        return ""


def extract_pptx_text_and_notes(pptx_path):
    """Zwraca słownik {slide_number: {'slideText': str, 'speakerNotes': str}} z pliku .pptx."""
    result = {}
    if not pptx_path.lower().endswith(".pptx") or not os.path.isfile(pptx_path):
        return result

    try:
        with zipfile.ZipFile(pptx_path, "r") as zf:
            names = zf.namelist()
            slide_files = sorted(
                [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)],
                key=_natural_slide_num,
            )
            for sfile in slide_files:
                snum = _natural_slide_num(sfile)
                slide_text = _extract_xml_text(zf.read(sfile))
                notes_text = ""

                # Sprawdź relacje slajdu, aby znaleźć przypisany notesSlide
                rels_path = f"ppt/slides/_rels/slide{snum}.xml.rels"
                if rels_path in names:
                    try:
                        rels_root = ET.fromstring(zf.read(rels_path))
                        for rel in rels_root:
                            target = rel.attrib.get("Target", "")
                            if "notesSlide" in target:
                                norm_target = target.replace("../", "ppt/").lstrip("/")
                                if not norm_target.startswith("ppt/"):
                                    norm_target = "ppt/notesSlides/" + os.path.basename(target)
                                if norm_target in names:
                                    notes_text = _extract_xml_text(zf.read(norm_target))
                                    break
                    except Exception:
                        pass

                result[snum] = {
                    "slideText": slide_text[:1800],
                    "speakerNotes": notes_text[:1800],
                }
    except Exception as e:
        print(f"[Presentation] Uwaga podczas odczytu tekstu PPTX: {e}")
    return result


def _run_powershell(script_text, timeout=120):
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script_text],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _convert_pptx_via_powerpoint_com(source_path, slides_dir):
    """Eksportuje slajdy PPTX/PPT do PNG 1920x1080 przez Microsoft PowerPoint COM."""
    src_esc = source_path.replace("'", "''")
    dst_esc = slides_dir.replace("'", "''")
    ps = f"""
$ErrorActionPreference = 'Stop'
$ppt = $null
$pres = $null
try {{
    $ppt = New-Object -ComObject PowerPoint.Application
    $pres = $ppt.Presentations.Open('{src_esc}', $true, $false, $false)
    $count = $pres.Slides.Count
    for ($i = 1; $i -le $count; $i++) {{
        $outFile = Join-Path '{dst_esc}' ('slide_' + $i.ToString('000') + '.png')
        $pres.Slides.Item($i).Export($outFile, 'PNG', 1920, 1080)
    }}
    Write-Output "OK:$count"
}} finally {{
    if ($pres -ne $null) {{ try {{ $pres.Close() }} catch {{}} }}
    if ($ppt -ne $null) {{ try {{ $ppt.Quit() }} catch {{}} }}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}}
"""
    rc, out, err = _run_powershell(ps, timeout=180)
    if rc == 0 and "OK:" in out:
        return True, ""
    return False, (err or out or "PowerPoint COM error").strip()


def _convert_pdf_to_pngs(pdf_path, slides_dir):
    """Konwertuje strony PDF na obrazy PNG i wyciąga tekst z każdej strony."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_path)
    total = len(pdf)
    text_map = {}
    for idx in range(total):
        page = pdf[idx]
        w, _ = page.get_size()
        scale = max(1.5, min(3.0, 1920.0 / max(1.0, float(w))))
        bitmap = page.render(scale=scale)
        pil_img = bitmap.to_pil()
        out_path = os.path.join(slides_dir, f"slide_{idx + 1:03d}.png")
        pil_img.save(out_path, format="PNG")
        try:
            tp = page.get_textpage()
            txt = tp.get_text_range() or ""
            text_map[idx + 1] = {"slideText": " ".join(txt.split())[:1800], "speakerNotes": ""}
        except Exception:
            text_map[idx + 1] = {"slideText": "", "speakerNotes": ""}
    pdf.close()
    return total, text_map


def _convert_office_via_libreoffice(source_path, temp_dir, slides_dir):
    """Fallback: konwersja PPTX/PPT przez LibreOffice (soffice) -> PDF -> PNG."""
    soffice = shutil.which("soffice")
    if not soffice:
        for candidate in [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]:
            if os.path.isfile(candidate):
                soffice = candidate
                break
    if not soffice:
        return False, "Brak Microsoft PowerPoint oraz LibreOffice na tym komputerze."

    proc = subprocess.run(
        [soffice, "--headless", "--convert-to", "pdf", "--outdir", temp_dir, source_path],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return False, proc.stderr or "Błąd konwersji LibreOffice"

    base_name = os.path.splitext(os.path.basename(source_path))[0] + ".pdf"
    pdf_path = os.path.join(temp_dir, base_name)
    if not os.path.isfile(pdf_path):
        return False, "LibreOffice nie wygenerował pliku PDF."
    _convert_pdf_to_pngs(pdf_path, slides_dir)
    return True, ""


def save_and_convert_presentation(file_name, raw_bytes):
    """Zapisuje wgrany plik prezentacji, konwertuje slajdy na PNG i buduje meta.json."""
    safe_name = os.path.basename(file_name or "prezentacja.pptx")
    ext = os.path.splitext(safe_name)[1].lower()
    if ext not in (".pptx", ".ppt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"):
        raise ValueError(f"Nieobsługiwany format pliku: {ext}. Użyj .pptx, .ppt, .pdf lub obrazu.")

    pres_id = f"pres_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    pres_dir = os.path.join(PRESENTATIONS_DIR, pres_id)
    slides_dir = os.path.join(pres_dir, "slides")
    os.makedirs(slides_dir, exist_ok=True)

    source_path = os.path.join(pres_dir, f"source{ext}")
    with open(source_path, "wb") as f:
        f.write(raw_bytes)

    text_map = {}

    try:
        if ext in (".pptx", ".ppt"):
            if ext == ".pptx":
                text_map = extract_pptx_text_and_notes(source_path)
            ok, err = _convert_pptx_via_powerpoint_com(source_path, slides_dir)
            if not ok:
                ok2, err2 = _convert_office_via_libreoffice(source_path, pres_dir, slides_dir)
                if not ok2:
                    raise RuntimeError(f"Nie udało się przekonwertować prezentacji: {err} | {err2}")
        elif ext == ".pdf":
            _, text_map = _convert_pdf_to_pngs(source_path, slides_dir)
        else:
            # Pojedynczy obraz jako 1-slajdowa prezentacja
            shutil.copy2(source_path, os.path.join(slides_dir, f"slide_001{ext}"))
    except Exception:
        shutil.rmtree(pres_dir, ignore_errors=True)
        raise

    slide_files = sorted(
        [f for f in os.listdir(slides_dir) if os.path.isfile(os.path.join(slides_dir, f))],
        key=_natural_slide_num,
    )
    if not slide_files:
        shutil.rmtree(pres_dir, ignore_errors=True)
        raise RuntimeError("Nie wygenerowano żadnych slajdów z przesłanego pliku.")

    slides_meta = []
    for idx, fname in enumerate(slide_files, start=1):
        txt_info = text_map.get(idx, {})
        slides_meta.append({
            "slideNumber": idx,
            "imageUrl": f"/presentations/{pres_id}/slides/{fname}",
            "slideText": txt_info.get("slideText", ""),
            "speakerNotes": txt_info.get("speakerNotes", ""),
        })

    meta = {
        "id": pres_id,
        "title": safe_name,
        "fileType": ext.lstrip("."),
        "sourcePath": source_path,
        "createdAt": int(time.time()),
        "totalSlides": len(slides_meta),
        "slides": slides_meta,
    }
    with open(os.path.join(pres_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return meta


def list_presentations():
    """Zwraca listę wszystkich wgranych prezentacji posortowaną od najnowszej."""
    items = []
    if not os.path.isdir(PRESENTATIONS_DIR):
        return items
    for entry in os.listdir(PRESENTATIONS_DIR):
        meta_path = os.path.join(PRESENTATIONS_DIR, entry, "meta.json")
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                items.append({
                    "id": meta["id"],
                    "title": meta["title"],
                    "fileType": meta.get("fileType", ""),
                    "createdAt": meta.get("createdAt", 0),
                    "totalSlides": meta.get("totalSlides", 0),
                    "thumbUrl": meta["slides"][0]["imageUrl"] if meta.get("slides") else None,
                })
            except Exception:
                continue
    items.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
    return items


def load_presentation_meta(pres_id):
    if not pres_id:
        return None
    meta_path = os.path.join(PRESENTATIONS_DIR, os.path.basename(pres_id), "meta.json")
    if not os.path.isfile(meta_path):
        return None
    with open(meta_path, "r", encoding="utf-8") as f:
        return json.load(f)


def delete_presentation(pres_id):
    safe_id = os.path.basename(pres_id)
    pres_dir = os.path.join(PRESENTATIONS_DIR, safe_id)
    if os.path.isdir(pres_dir):
        shutil.rmtree(pres_dir, ignore_errors=True)
    with PRES_LOCK:
        if PRESENTATION_STATE["presentationId"] == safe_id:
            PRESENTATION_STATE["active"] = False
            PRESENTATION_STATE["presentationId"] = None
            PRESENTATION_STATE["title"] = ""
            PRESENTATION_STATE["totalSlides"] = 0
            PRESENTATION_STATE["currentSlide"] = 1
            PRESENTATION_STATE["currentSlideUrl"] = None
            PRESENTATION_STATE["nextSlideUrl"] = None
            PRESENTATION_STATE["currentSlideText"] = ""
            PRESENTATION_STATE["currentSpeakerNotes"] = ""
            PRESENTATION_STATE["version"] += 1


def _sync_slide_fields_locked(meta):
    slides = meta.get("slides") or []
    total = len(slides)
    PRESENTATION_STATE["totalSlides"] = total
    if total == 0:
        PRESENTATION_STATE["currentSlide"] = 1
        PRESENTATION_STATE["currentSlideUrl"] = None
        PRESENTATION_STATE["nextSlideUrl"] = None
        PRESENTATION_STATE["currentSlideText"] = ""
        PRESENTATION_STATE["currentSpeakerNotes"] = ""
        return

    cur = max(1, min(total, int(PRESENTATION_STATE["currentSlide"] or 1)))
    PRESENTATION_STATE["currentSlide"] = cur
    cur_obj = slides[cur - 1]
    nxt_obj = slides[cur] if cur < total else None
    PRESENTATION_STATE["currentSlideUrl"] = cur_obj.get("imageUrl")
    PRESENTATION_STATE["nextSlideUrl"] = nxt_obj.get("imageUrl") if nxt_obj else None
    PRESENTATION_STATE["currentSlideText"] = cur_obj.get("slideText", "")
    PRESENTATION_STATE["currentSpeakerNotes"] = cur_obj.get("speakerNotes", "")


def select_presentation(pres_id, activate=True):
    meta = load_presentation_meta(pres_id)
    if not meta:
        raise FileNotFoundError("Nie znaleziono wybranej prezentacji.")
    with PRES_LOCK:
        PRESENTATION_STATE["presentationId"] = meta["id"]
        PRESENTATION_STATE["title"] = meta["title"]
        PRESENTATION_STATE["fileType"] = meta.get("fileType", "")
        PRESENTATION_STATE["currentSlide"] = 1
        PRESENTATION_STATE["blackoutSlide"] = False
        if activate:
            PRESENTATION_STATE["active"] = True
        _sync_slide_fields_locked(meta)
        PRESENTATION_STATE["version"] += 1
        return dict(PRESENTATION_STATE), meta


def _native_ppt_command(action, source_path=None, slide_num=None, blackout=False):
    """Wysyła polecenie sterowania do uruchomionego Microsoft PowerPoint (COM)."""
    if os.name != "nt":
        return False, "Natywny PowerPoint dostępny jest tylko w systemie Windows."

    src_esc = (source_path or "").replace("'", "''")
    if action == "start":
        ps = f"""
$ErrorActionPreference = 'Stop'
try {{
    $ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
}} catch {{
    $ppt = New-Object -ComObject PowerPoint.Application
}}
$ppt.Visible = $true
$pres = $null
foreach ($p in $ppt.Presentations) {{
    if ($p.FullName -eq '{src_esc}') {{ $pres = $p; break }}
}}
if ($pres -eq $null) {{
    $pres = $ppt.Presentations.Open('{src_esc}', $false, $false, $true)
}}
$ss = $pres.SlideShowSettings.Run()
Write-Output 'OK'
"""
    elif action == "next":
        ps = """
$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
if ($ppt.SlideShowWindows.Count -gt 0) { $ppt.SlideShowWindows.Item(1).View.Next() }
"""
    elif action == "prev":
        ps = """
$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
if ($ppt.SlideShowWindows.Count -gt 0) { $ppt.SlideShowWindows.Item(1).View.Previous() }
"""
    elif action == "goto":
        n = int(slide_num or 1)
        ps = f"""
$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
if ($ppt.SlideShowWindows.Count -gt 0) {{ $ppt.SlideShowWindows.Item(1).View.GotoSlide({n}) }}
"""
    elif action == "blackout":
        state_val = 3 if blackout else 1  # 3 = ppSlideShowBlackScreen, 1 = ppSlideShowRunning
        ps = f"""
$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
if ($ppt.SlideShowWindows.Count -gt 0) {{ $ppt.SlideShowWindows.Item(1).View.State = {state_val} }}
"""
    elif action == "stop":
        ps = """
$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
if ($ppt.SlideShowWindows.Count -gt 0) { $ppt.SlideShowWindows.Item(1).View.Exit() }
"""
    else:
        return False, "Nieznana akcja PowerPoint."

    try:
        rc, _, err = _run_powershell(ps, timeout=20)
        return rc == 0, err.strip()
    except Exception as e:
        return False, str(e)


def start_overlay_process(port=8765, monitor_index=0):
    global OVERLAY_PROC
    stop_overlay_process()
    overlay_script = os.path.join(BASE_DIR, "overlay_window.py")
    if not os.path.isfile(overlay_script):
        return False
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    OVERLAY_PROC = subprocess.Popen(
        [sys.executable, overlay_script, "--port", str(port), "--monitor", str(int(monitor_index))],
        cwd=BASE_DIR,
        creationflags=creation_flags,
    )
    with PRES_LOCK:
        PRESENTATION_STATE["nativeOverlayActive"] = True
        PRESENTATION_STATE["nativeMonitorIndex"] = int(monitor_index)
        PRESENTATION_STATE["version"] += 1
    return True


def stop_overlay_process():
    global OVERLAY_PROC
    if OVERLAY_PROC is not None:
        try:
            OVERLAY_PROC.terminate()
            OVERLAY_PROC.wait(timeout=2)
        except Exception:
            try:
                OVERLAY_PROC.kill()
            except Exception:
                pass
        OVERLAY_PROC = None
    with PRES_LOCK:
        if PRESENTATION_STATE["nativeOverlayActive"]:
            PRESENTATION_STATE["nativeOverlayActive"] = False
            PRESENTATION_STATE["version"] += 1


def control_presentation(payload, main_port=8765):
    """Wykonuje akcję sterowania prezentacją (next/prev/goto/blackout/toggleSubtitles/settings/mode/overlay)."""
    action = (payload.get("action") or "").strip()

    with PRES_LOCK:
        pres_id = payload.get("presentationId") or PRESENTATION_STATE["presentationId"]
        meta = load_presentation_meta(pres_id) if pres_id else None

        if action == "activate":
            PRESENTATION_STATE["active"] = bool(payload.get("active", True))
        elif action == "deactivate":
            PRESENTATION_STATE["active"] = False
        elif action == "mode":
            new_mode = payload.get("mode", "browser")
            if new_mode in ("browser", "native"):
                PRESENTATION_STATE["mode"] = new_mode
        elif action == "next":
            if meta and PRESENTATION_STATE["currentSlide"] < meta["totalSlides"]:
                PRESENTATION_STATE["currentSlide"] += 1
                PRESENTATION_STATE["active"] = True
        elif action == "prev":
            if meta and PRESENTATION_STATE["currentSlide"] > 1:
                PRESENTATION_STATE["currentSlide"] -= 1
                PRESENTATION_STATE["active"] = True
        elif action == "goto":
            if meta:
                target = int(payload.get("slide") or 1)
                PRESENTATION_STATE["currentSlide"] = max(1, min(meta["totalSlides"], target))
                PRESENTATION_STATE["active"] = True
        elif action == "blackout":
            PRESENTATION_STATE["blackoutSlide"] = (
                bool(payload["blackoutSlide"])
                if "blackoutSlide" in payload
                else not PRESENTATION_STATE["blackoutSlide"]
            )
        elif action == "toggleSubtitles":
            PRESENTATION_STATE["hideSubtitles"] = (
                bool(payload["hideSubtitles"])
                if "hideSubtitles" in payload
                else not PRESENTATION_STATE["hideSubtitles"]
            )
        elif action == "settings":
            if payload.get("subtitlePosition") in ("bottom", "top", "center"):
                PRESENTATION_STATE["subtitlePosition"] = payload["subtitlePosition"]
            if "subtitleOpacity" in payload:
                PRESENTATION_STATE["subtitleOpacity"] = max(0.0, min(0.95, float(payload["subtitleOpacity"])))
            if "subtitleFontScale" in payload:
                PRESENTATION_STATE["subtitleFontScale"] = max(0.55, min(1.5, float(payload["subtitleFontScale"])))
            if "nativeMonitorIndex" in payload:
                PRESENTATION_STATE["nativeMonitorIndex"] = int(payload["nativeMonitorIndex"])

        if meta:
            _sync_slide_fields_locked(meta)

        PRESENTATION_STATE["version"] += 1
        state_snap = dict(PRESENTATION_STATE)

    # Obsługa natywnego PowerPointa oraz nakładki poza lockiem
    if action == "nativeStart" and meta:
        with PRES_LOCK:
            PRESENTATION_STATE["mode"] = "native"
            PRESENTATION_STATE["active"] = True
            PRESENTATION_STATE["version"] += 1
            mon_idx = PRESENTATION_STATE["nativeMonitorIndex"]
        threading.Thread(
            target=_native_ppt_command,
            args=("start", meta.get("sourcePath")),
            daemon=True,
        ).start()
        start_overlay_process(port=main_port, monitor_index=mon_idx)
        return get_presentation_state()

    if action == "nativeStop":
        stop_overlay_process()
        threading.Thread(target=_native_ppt_command, args=("stop",), daemon=True).start()
        with PRES_LOCK:
            PRESENTATION_STATE["mode"] = "browser"
            PRESENTATION_STATE["version"] += 1
        return get_presentation_state()

    if action == "overlayStart":
        mon_idx = int(payload.get("monitorIndex", state_snap["nativeMonitorIndex"]))
        start_overlay_process(port=main_port, monitor_index=mon_idx)
        return get_presentation_state()

    if action == "overlayStop":
        stop_overlay_process()
        return get_presentation_state()

    if state_snap["mode"] == "native" and action in ("next", "prev", "goto", "blackout"):
        cmd_map = {
            "next": ("next", None, False),
            "prev": ("prev", None, False),
            "goto": ("goto", state_snap["currentSlide"], False),
            "blackout": ("blackout", None, state_snap["blackoutSlide"]),
        }
        c_act, c_slide, c_blk = cmd_map[action]
        threading.Thread(
            target=_native_ppt_command,
            args=(c_act, None, c_slide, c_blk),
            daemon=True,
        ).start()

    return state_snap


def get_presentation_state():
    with PRES_LOCK:
        return dict(PRESENTATION_STATE)
