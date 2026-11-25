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
PLAYLIST_PATH = os.path.join(PRESENTATIONS_DIR, "playlist.json")
os.makedirs(PRESENTATIONS_DIR, exist_ok=True)

VIDEO_EXTS = (".mp4", ".webm", ".mov")
ANIM_IMAGE_EXTS = (".gif",)
STATIC_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
OFFICE_PDF_EXTS = (".pptx", ".ppt", ".pdf")
SUPPORTED_UPLOAD_EXTS = OFFICE_PDF_EXTS + STATIC_IMAGE_EXTS + VIDEO_EXTS + ANIM_IMAGE_EXTS

PRES_LOCK = threading.Lock()
OVERLAY_PROC = None

PRESENTATION_STATE = {
    "version": 0,
    "cueSeq": 0,
    "active": False,
    "mode": "browser",  # 'browser' | 'native'
    "presentationId": None,
    "title": "",
    "fileType": "",
    "mediaKind": "slides",  # 'slides' | 'video' | 'anim-image' | 'image'
    "isAnimation": False,
    "currentMediaType": "image",  # 'image' | 'video' | 'anim-image'
    "objectFit": "contain",  # 'cover' | 'contain'
    "animLoop": True,
    "animAutoAdvance": False,
    "animPlaying": True,
    "animSeekSec": 0.0,
    "animUpdatedAt": 0.0,
    "animAction": "play",  # 'play' | 'pause' | 'restart' | 'seek'
    "animActionSeq": 0,
    "currentSlide": 1,
    "totalSlides": 0,
    "blackoutSlide": False,
    "hideSubtitles": False,
    "slideTransition": "fade",  # 'fade' | 'slide-fade' | 'zoom-fade' | 'none'
    "effectiveTransition": "fade",
    "subtitleLayoutMode": "overlay",  # 'overlay' | 'split'
    "subtitlePosition": "bottom",  # 'bottom' | 'top' | 'center'
    "subtitleOpacity": 0.78,
    "subtitleFontScale": 0.85,
    "subtitleAreaHeightPct": 22,
    "subtitleAreaWidthPct": 90,
    "currentSlideUrl": None,
    "nextSlideUrl": None,
    "nextSlideMediaType": None,
    "nextSlideLabel": "",
    "currentSlideText": "",
    "currentSpeakerNotes": "",
    "nativeOverlayActive": False,
    "nativeMonitorIndex": 0,
    "playlistActive": False,
    "playlistIndex": -1,
    "playlistTotal": 0,
    "playlistEntryId": None,
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


def _is_animated_webp(raw_bytes):
    """Sprawdza po nagłówkach RIFF/WEBP, czy plik .webp zawiera animację (VP8X/ANIM/ANMF)."""
    if not raw_bytes or len(raw_bytes) < 32:
        return False
    if raw_bytes[:4] != b"RIFF" or raw_bytes[8:12] != b"WEBP":
        return False
    if raw_bytes[12:16] == b"VP8X" and len(raw_bytes) >= 21:
        flags = raw_bytes[20]
        if flags & 0x02:
            return True
    return (b"ANIM" in raw_bytes[:4096]) or (b"ANMF" in raw_bytes[:4096])


def _infer_slide_media_type(fname_or_ext, is_anim_webp=False):
    ext = os.path.splitext(fname_or_ext)[1].lower() if "." in fname_or_ext else f".{fname_or_ext.lower().lstrip('.')}"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in ANIM_IMAGE_EXTS or (ext == ".webp" and is_anim_webp):
        return "anim-image"
    return "image"


def _save_presentation_meta(meta):
    pres_id = os.path.basename(meta["id"])
    meta_path = os.path.join(PRESENTATIONS_DIR, pres_id, "meta.json")
    if os.path.isdir(os.path.dirname(meta_path)):
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)


def save_and_convert_presentation(file_name, raw_bytes):
    """Zapisuje wgrany plik prezentacji lub animacji, konwertuje slajdy i buduje meta.json."""
    safe_name = os.path.basename(file_name or "prezentacja.pptx")
    ext = os.path.splitext(safe_name)[1].lower()
    if ext not in SUPPORTED_UPLOAD_EXTS:
        raise ValueError(
            f"Nieobsługiwany format pliku: {ext}. Użyj .pptx, .ppt, .pdf, obrazu (.png/.jpg/.webp) lub animacji (.mp4/.webm/.mov/.gif)."
        )

    is_anim_webp = (ext == ".webp") and _is_animated_webp(raw_bytes)
    is_video = ext in VIDEO_EXTS
    is_anim_img = (ext in ANIM_IMAGE_EXTS) or is_anim_webp
    is_animation = is_video or is_anim_img

    if ext in OFFICE_PDF_EXTS:
        media_kind = "slides"
    elif is_video:
        media_kind = "video"
    elif is_anim_img:
        media_kind = "anim-image"
    else:
        media_kind = "image"

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
            # Pojedynczy obraz lub animacja wideo/GIF/WebP
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
        raise RuntimeError("Nie wygenerowano żadnych slajdów ani mediów z przesłanego pliku.")

    slides_meta = []
    for idx, fname in enumerate(slide_files, start=1):
        txt_info = text_map.get(idx, {})
        slide_mtype = _infer_slide_media_type(fname, is_anim_webp=is_anim_webp) if ext not in OFFICE_PDF_EXTS else "image"
        slides_meta.append({
            "slideNumber": idx,
            "imageUrl": f"/presentations/{pres_id}/slides/{fname}",
            "mediaType": slide_mtype,
            "slideText": txt_info.get("slideText", ""),
            "speakerNotes": txt_info.get("speakerNotes", ""),
        })

    meta = {
        "id": pres_id,
        "title": safe_name,
        "fileType": ext.lstrip("."),
        "mediaKind": media_kind,
        "isAnimation": is_animation,
        "defaultLoop": True,
        "defaultFit": "cover" if is_animation else "contain",
        "sourcePath": source_path,
        "createdAt": int(time.time()),
        "totalSlides": len(slides_meta),
        "slides": slides_meta,
    }
    _save_presentation_meta(meta)
    return meta


def _normalize_meta(meta):
    """Uzupełnia pola animacji dla starszych plików meta.json."""
    if not meta:
        return None
    ft = (meta.get("fileType") or "").lower()
    if "mediaKind" not in meta:
        if f".{ft}" in VIDEO_EXTS:
            meta["mediaKind"] = "video"
        elif f".{ft}" in ANIM_IMAGE_EXTS:
            meta["mediaKind"] = "anim-image"
        elif f".{ft}" in OFFICE_PDF_EXTS:
            meta["mediaKind"] = "slides"
        else:
            meta["mediaKind"] = "image"
    meta["isAnimation"] = bool(meta.get("isAnimation", meta["mediaKind"] in ("video", "anim-image")))
    if "defaultLoop" not in meta:
        meta["defaultLoop"] = True
    if "defaultFit" not in meta:
        meta["defaultFit"] = "cover" if meta["isAnimation"] else "contain"
    for s in meta.get("slides") or []:
        if "mediaType" not in s:
            s["mediaType"] = meta["mediaKind"] if meta["mediaKind"] in ("video", "anim-image") else "image"
    return meta


def list_presentations():
    """Zwraca listę wszystkich wgranych prezentacji i animacji posortowaną od najnowszej."""
    items = []
    if not os.path.isdir(PRESENTATIONS_DIR):
        return items
    for entry in os.listdir(PRESENTATIONS_DIR):
        meta_path = os.path.join(PRESENTATIONS_DIR, entry, "meta.json")
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = _normalize_meta(json.load(f))
                first_slide = meta["slides"][0] if meta.get("slides") else {}
                items.append({
                    "id": meta["id"],
                    "title": meta["title"],
                    "fileType": meta.get("fileType", ""),
                    "mediaKind": meta.get("mediaKind", "slides"),
                    "isAnimation": meta.get("isAnimation", False),
                    "defaultLoop": meta.get("defaultLoop", True),
                    "defaultFit": meta.get("defaultFit", "contain"),
                    "createdAt": meta.get("createdAt", 0),
                    "totalSlides": meta.get("totalSlides", 0),
                    "thumbUrl": first_slide.get("imageUrl"),
                    "thumbMediaType": first_slide.get("mediaType", "image"),
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
        return _normalize_meta(json.load(f))


def _load_raw_playlist_locked():
    if not os.path.isfile(PLAYLIST_PATH):
        return []
    try:
        with open(PLAYLIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items") if isinstance(data, dict) else []
        return items if isinstance(items, list) else []
    except Exception:
        return []


def _save_raw_playlist_locked(items):
    with open(PLAYLIST_PATH, "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=2)


def _sanitize_playlist_entry(raw_entry, meta=None):
    pres_id = (raw_entry.get("presentationId") or "").strip()
    if not pres_id:
        return None
    if meta is None:
        meta = load_presentation_meta(pres_id)
    if not meta:
        return None

    is_anim = bool(meta.get("isAnimation"))
    default_beh = ("loop" if meta.get("defaultLoop", True) else "once-hold") if is_anim else "loop"
    anim_beh = raw_entry.get("animBehavior") or default_beh
    if anim_beh not in ("loop", "once-hold", "once-next"):
        anim_beh = default_beh

    default_fit = meta.get("defaultFit") or ("cover" if is_anim else "contain")
    obj_fit = raw_entry.get("objectFit") or default_fit
    if obj_fit not in ("cover", "contain"):
        obj_fit = default_fit

    sub_rule = raw_entry.get("subtitlesRule") or "keep"
    if sub_rule not in ("keep", "show", "hide"):
        sub_rule = "keep"

    entry_trans = raw_entry.get("entryTransition") or "default"
    if entry_trans not in ("default", "fade", "slide-fade", "zoom-fade", "none"):
        entry_trans = "default"

    entry_id = raw_entry.get("entryId") or f"pl_{int(time.time() * 1000)}_{uuid.uuid4().hex[:5]}"
    return {
        "entryId": entry_id,
        "presentationId": pres_id,
        "animBehavior": anim_beh,
        "objectFit": obj_fit,
        "subtitlesRule": sub_rule,
        "entryTransition": entry_trans,
    }


def _get_enriched_playlist_locked():
    raw_items = _load_raw_playlist_locked()
    enriched = []
    cleaned_raw = []
    changed = False
    for raw in raw_items:
        meta = load_presentation_meta(raw.get("presentationId"))
        if not meta:
            changed = True
            continue
        clean = _sanitize_playlist_entry(raw, meta=meta)
        if not clean:
            changed = True
            continue
        if clean.get("entryId") != raw.get("entryId"):
            changed = True
        cleaned_raw.append(clean)
        first_slide = meta["slides"][0] if meta.get("slides") else {}
        enriched.append({
            **clean,
            "title": meta.get("title", ""),
            "fileType": meta.get("fileType", ""),
            "mediaKind": meta.get("mediaKind", "slides"),
            "isAnimation": bool(meta.get("isAnimation")),
            "totalSlides": meta.get("totalSlides", 0),
            "thumbUrl": first_slide.get("imageUrl"),
            "thumbMediaType": first_slide.get("mediaType", "image"),
        })
    if changed:
        _save_raw_playlist_locked(cleaned_raw)
    return enriched


def get_playlist():
    with PRES_LOCK:
        items = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(items)
        return items


def save_playlist(new_items):
    """Zapisuje nową listę elementów playlisty (kolejność, dodanie, usunięcie, ustawienia per pozycja)."""
    if not isinstance(new_items, list):
        raise ValueError("Nieprawidłowy format playlisty.")
    with PRES_LOCK:
        sanitized = []
        for raw in new_items:
            if not isinstance(raw, dict):
                continue
            clean = _sanitize_playlist_entry(raw)
            if clean:
                sanitized.append(clean)
        _save_raw_playlist_locked(sanitized)
        enriched = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(enriched)

        if PRESENTATION_STATE["playlistActive"]:
            cur_eid = PRESENTATION_STATE.get("playlistEntryId")
            found_idx = next((idx for idx, it in enumerate(enriched) if it["entryId"] == cur_eid), -1)
            if found_idx == -1:
                PRESENTATION_STATE["playlistActive"] = False
                PRESENTATION_STATE["playlistIndex"] = -1
                PRESENTATION_STATE["playlistEntryId"] = None
            else:
                PRESENTATION_STATE["playlistIndex"] = found_idx
                active_entry = enriched[found_idx]
                PRESENTATION_STATE["objectFit"] = active_entry["objectFit"]
                if PRESENTATION_STATE["isAnimation"]:
                    PRESENTATION_STATE["animLoop"] = active_entry["animBehavior"] == "loop"
                    PRESENTATION_STATE["animAutoAdvance"] = active_entry["animBehavior"] == "once-next"
                if active_entry["subtitlesRule"] == "hide":
                    PRESENTATION_STATE["hideSubtitles"] = True
                elif active_entry["subtitlesRule"] == "show":
                    PRESENTATION_STATE["hideSubtitles"] = False
                meta = load_presentation_meta(PRESENTATION_STATE["presentationId"])
                if meta:
                    _sync_slide_fields_locked(meta)

        PRESENTATION_STATE["version"] += 1
        return enriched, dict(PRESENTATION_STATE)


def delete_presentation(pres_id):
    safe_id = os.path.basename(pres_id)
    pres_dir = os.path.join(PRESENTATIONS_DIR, safe_id)
    if os.path.isdir(pres_dir):
        shutil.rmtree(pres_dir, ignore_errors=True)
    with PRES_LOCK:
        raw_pl = _load_raw_playlist_locked()
        filtered_pl = [it for it in raw_pl if it.get("presentationId") != safe_id]
        if len(filtered_pl) != len(raw_pl):
            _save_raw_playlist_locked(filtered_pl)
        enriched = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(enriched)

        if PRESENTATION_STATE["presentationId"] == safe_id:
            PRESENTATION_STATE["active"] = False
            PRESENTATION_STATE["presentationId"] = None
            PRESENTATION_STATE["title"] = ""
            PRESENTATION_STATE["fileType"] = ""
            PRESENTATION_STATE["mediaKind"] = "slides"
            PRESENTATION_STATE["isAnimation"] = False
            PRESENTATION_STATE["currentMediaType"] = "image"
            PRESENTATION_STATE["totalSlides"] = 0
            PRESENTATION_STATE["currentSlide"] = 1
            PRESENTATION_STATE["currentSlideUrl"] = None
            PRESENTATION_STATE["nextSlideUrl"] = None
            PRESENTATION_STATE["nextSlideMediaType"] = None
            PRESENTATION_STATE["nextSlideLabel"] = ""
            PRESENTATION_STATE["currentSlideText"] = ""
            PRESENTATION_STATE["currentSpeakerNotes"] = ""
            PRESENTATION_STATE["playlistActive"] = False
            PRESENTATION_STATE["playlistIndex"] = -1
            PRESENTATION_STATE["playlistEntryId"] = None
            PRESENTATION_STATE["version"] += 1
        elif PRESENTATION_STATE["playlistActive"]:
            cur_eid = PRESENTATION_STATE.get("playlistEntryId")
            found_idx = next((idx for idx, it in enumerate(enriched) if it["entryId"] == cur_eid), -1)
            PRESENTATION_STATE["playlistIndex"] = found_idx
            if found_idx == -1:
                PRESENTATION_STATE["playlistActive"] = False
                PRESENTATION_STATE["playlistEntryId"] = None
            PRESENTATION_STATE["version"] += 1


def _reset_anim_playback_locked():
    PRESENTATION_STATE["animPlaying"] = True
    PRESENTATION_STATE["animSeekSec"] = 0.0
    PRESENTATION_STATE["animUpdatedAt"] = time.time()
    PRESENTATION_STATE["animAction"] = "restart"
    PRESENTATION_STATE["animActionSeq"] += 1


def _sync_slide_fields_locked(meta, enriched_playlist=None):
    slides = meta.get("slides") or []
    total = len(slides)
    PRESENTATION_STATE["totalSlides"] = total
    PRESENTATION_STATE["title"] = meta.get("title", "")
    PRESENTATION_STATE["fileType"] = meta.get("fileType", "")
    PRESENTATION_STATE["mediaKind"] = meta.get("mediaKind", "slides")
    PRESENTATION_STATE["isAnimation"] = bool(meta.get("isAnimation"))

    if PRESENTATION_STATE["isAnimation"] and PRESENTATION_STATE["mode"] == "native":
        PRESENTATION_STATE["mode"] = "browser"

    if total == 0:
        PRESENTATION_STATE["currentSlide"] = 1
        PRESENTATION_STATE["currentSlideUrl"] = None
        PRESENTATION_STATE["currentMediaType"] = "image"
        PRESENTATION_STATE["nextSlideUrl"] = None
        PRESENTATION_STATE["nextSlideMediaType"] = None
        PRESENTATION_STATE["nextSlideLabel"] = ""
        PRESENTATION_STATE["currentSlideText"] = ""
        PRESENTATION_STATE["currentSpeakerNotes"] = ""
        return

    cur = max(1, min(total, int(PRESENTATION_STATE["currentSlide"] or 1)))
    PRESENTATION_STATE["currentSlide"] = cur
    cur_obj = slides[cur - 1]
    nxt_obj = slides[cur] if cur < total else None
    PRESENTATION_STATE["currentSlideUrl"] = cur_obj.get("imageUrl")
    PRESENTATION_STATE["currentMediaType"] = cur_obj.get("mediaType", "image")
    PRESENTATION_STATE["currentSlideText"] = cur_obj.get("slideText", "")
    PRESENTATION_STATE["currentSpeakerNotes"] = cur_obj.get("speakerNotes", "")

    if nxt_obj:
        PRESENTATION_STATE["nextSlideUrl"] = nxt_obj.get("imageUrl")
        PRESENTATION_STATE["nextSlideMediaType"] = nxt_obj.get("mediaType", "image")
        PRESENTATION_STATE["nextSlideLabel"] = f"Slajd {cur + 1} / {total}"
    elif PRESENTATION_STATE["playlistActive"]:
        if enriched_playlist is None:
            enriched_playlist = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(enriched_playlist)
        nxt_pl_idx = PRESENTATION_STATE["playlistIndex"] + 1
        if 0 <= nxt_pl_idx < len(enriched_playlist):
            nxt_entry = enriched_playlist[nxt_pl_idx]
            PRESENTATION_STATE["nextSlideUrl"] = nxt_entry.get("thumbUrl")
            PRESENTATION_STATE["nextSlideMediaType"] = nxt_entry.get("thumbMediaType", "image")
            PRESENTATION_STATE["nextSlideLabel"] = f"Kolejne z playlisty ({nxt_pl_idx + 1}/{len(enriched_playlist)}): {nxt_entry.get('title', '')}"
        else:
            PRESENTATION_STATE["nextSlideUrl"] = None
            PRESENTATION_STATE["nextSlideMediaType"] = None
            PRESENTATION_STATE["nextSlideLabel"] = ""
    else:
        PRESENTATION_STATE["nextSlideUrl"] = None
        PRESENTATION_STATE["nextSlideMediaType"] = None
        PRESENTATION_STATE["nextSlideLabel"] = ""


def _activate_playlist_entry_locked(pl_index, slide_num=1, enriched=None):
    if enriched is None:
        enriched = _get_enriched_playlist_locked()
    PRESENTATION_STATE["playlistTotal"] = len(enriched)
    if not enriched or not (0 <= pl_index < len(enriched)):
        return None
    entry = enriched[pl_index]
    meta = load_presentation_meta(entry["presentationId"])
    if not meta:
        return None

    PRESENTATION_STATE["playlistActive"] = True
    PRESENTATION_STATE["playlistIndex"] = pl_index
    PRESENTATION_STATE["playlistEntryId"] = entry["entryId"]
    PRESENTATION_STATE["presentationId"] = meta["id"]
    PRESENTATION_STATE["active"] = True
    PRESENTATION_STATE["blackoutSlide"] = False

    total = max(1, int(meta.get("totalSlides") or 1))
    PRESENTATION_STATE["currentSlide"] = max(1, min(total, int(slide_num)))

    PRESENTATION_STATE["objectFit"] = entry.get("objectFit") or meta.get("defaultFit", "contain")
    if meta.get("isAnimation"):
        beh = entry.get("animBehavior", "loop")
        PRESENTATION_STATE["animLoop"] = beh == "loop"
        PRESENTATION_STATE["animAutoAdvance"] = beh == "once-next"
        _reset_anim_playback_locked()
    else:
        PRESENTATION_STATE["animLoop"] = True
        PRESENTATION_STATE["animAutoAdvance"] = False

    sub_rule = entry.get("subtitlesRule", "keep")
    if sub_rule == "hide":
        PRESENTATION_STATE["hideSubtitles"] = True
    elif sub_rule == "show":
        PRESENTATION_STATE["hideSubtitles"] = False

    entry_trans = entry.get("entryTransition", "default")
    PRESENTATION_STATE["effectiveTransition"] = (
        PRESENTATION_STATE["slideTransition"] if entry_trans == "default" else entry_trans
    )

    PRESENTATION_STATE["cueSeq"] += 1
    _sync_slide_fields_locked(meta, enriched_playlist=enriched)
    return meta


def select_presentation(pres_id, activate=True):
    meta = load_presentation_meta(pres_id)
    if not meta:
        raise FileNotFoundError("Nie znaleziono wybranej prezentacji.")
    with PRES_LOCK:
        enriched = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(enriched)
        PRESENTATION_STATE["playlistActive"] = False
        PRESENTATION_STATE["playlistIndex"] = -1
        PRESENTATION_STATE["playlistEntryId"] = None

        PRESENTATION_STATE["presentationId"] = meta["id"]
        PRESENTATION_STATE["currentSlide"] = 1
        PRESENTATION_STATE["blackoutSlide"] = False
        PRESENTATION_STATE["objectFit"] = meta.get("defaultFit", "cover" if meta.get("isAnimation") else "contain")
        PRESENTATION_STATE["animLoop"] = bool(meta.get("defaultLoop", True))
        PRESENTATION_STATE["animAutoAdvance"] = False
        PRESENTATION_STATE["effectiveTransition"] = PRESENTATION_STATE["slideTransition"]
        if meta.get("isAnimation"):
            _reset_anim_playback_locked()
        if activate:
            PRESENTATION_STATE["active"] = True
        PRESENTATION_STATE["cueSeq"] += 1
        _sync_slide_fields_locked(meta, enriched_playlist=enriched)
        PRESENTATION_STATE["version"] += 1
        return dict(PRESENTATION_STATE), meta


def _native_ppt_command(action, source_path=None, slide_num=None, blackout=False, monitor_index=0):
    """Wysyła polecenie sterowania do uruchomionego Microsoft PowerPoint (COM)."""
    if os.name != "nt":
        return False, "Natywny PowerPoint dostępny jest tylko w systemie Windows."

    src_esc = (source_path or "").replace("'", "''")
    if action == "start":
        monitors = get_windows_monitors()
        mon = monitors[monitor_index] if 0 <= int(monitor_index) < len(monitors) else monitors[0]
        m_left, m_top, m_w, m_h = int(mon["left"]), int(mon["top"]), int(mon["width"]), int(mon["height"])
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
try {{
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PptWinPos {{
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}}
"@ -ErrorAction SilentlyContinue
    $hwnd = [IntPtr]$ss.HWND
    if ($hwnd -ne [IntPtr]::Zero) {{
        [PptWinPos]::SetWindowPos($hwnd, [IntPtr]::Zero, {m_left}, {m_top}, {m_w}, {m_h}, 0x0040) | Out-Null
    }}
}} catch {{}}
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
    """Wykonuje akcję sterowania prezentacją, animacją lub playlistą."""
    action = (payload.get("action") or "").strip()

    with PRES_LOCK:
        enriched_pl = _get_enriched_playlist_locked()
        PRESENTATION_STATE["playlistTotal"] = len(enriched_pl)
        pres_id = payload.get("presentationId") or PRESENTATION_STATE["presentationId"]
        meta = load_presentation_meta(pres_id) if pres_id else None
        sync_needed = True

        if action == "activate":
            PRESENTATION_STATE["active"] = bool(payload.get("active", True))
        elif action == "deactivate":
            PRESENTATION_STATE["active"] = False
            PRESENTATION_STATE["playlistActive"] = False
        elif action == "mode":
            new_mode = payload.get("mode", "browser")
            if new_mode in ("browser", "native"):
                if new_mode == "native" and PRESENTATION_STATE.get("isAnimation"):
                    PRESENTATION_STATE["mode"] = "browser"
                else:
                    PRESENTATION_STATE["mode"] = new_mode
        elif action == "playlistStart":
            target_idx = int(payload.get("index", 0))
            if "entryId" in payload and payload["entryId"]:
                found = next((i for i, it in enumerate(enriched_pl) if it["entryId"] == payload["entryId"]), -1)
                if found != -1:
                    target_idx = found
            if enriched_pl:
                target_idx = max(0, min(len(enriched_pl) - 1, target_idx))
                meta = _activate_playlist_entry_locked(target_idx, slide_num=1, enriched=enriched_pl)
                sync_needed = False
        elif action == "playlistStop":
            PRESENTATION_STATE["playlistActive"] = False
            PRESENTATION_STATE["playlistIndex"] = -1
            PRESENTATION_STATE["playlistEntryId"] = None
        elif action == "next":
            if meta and PRESENTATION_STATE["currentSlide"] < meta["totalSlides"]:
                PRESENTATION_STATE["currentSlide"] += 1
                PRESENTATION_STATE["active"] = True
                PRESENTATION_STATE["effectiveTransition"] = PRESENTATION_STATE["slideTransition"]
                PRESENTATION_STATE["cueSeq"] += 1
            elif PRESENTATION_STATE["playlistActive"] and (PRESENTATION_STATE["playlistIndex"] + 1) < len(enriched_pl):
                meta = _activate_playlist_entry_locked(
                    PRESENTATION_STATE["playlistIndex"] + 1, slide_num=1, enriched=enriched_pl
                )
                sync_needed = False
        elif action == "prev":
            if meta and PRESENTATION_STATE["currentSlide"] > 1:
                PRESENTATION_STATE["currentSlide"] -= 1
                PRESENTATION_STATE["active"] = True
                PRESENTATION_STATE["effectiveTransition"] = PRESENTATION_STATE["slideTransition"]
                PRESENTATION_STATE["cueSeq"] += 1
            elif PRESENTATION_STATE["playlistActive"] and PRESENTATION_STATE["playlistIndex"] > 0:
                prev_idx = PRESENTATION_STATE["playlistIndex"] - 1
                prev_meta = load_presentation_meta(enriched_pl[prev_idx]["presentationId"])
                last_slide = prev_meta["totalSlides"] if prev_meta else 1
                meta = _activate_playlist_entry_locked(prev_idx, slide_num=last_slide, enriched=enriched_pl)
                sync_needed = False
        elif action == "goto":
            if meta:
                target = int(payload.get("slide") or 1)
                PRESENTATION_STATE["currentSlide"] = max(1, min(meta["totalSlides"], target))
                PRESENTATION_STATE["active"] = True
                PRESENTATION_STATE["effectiveTransition"] = PRESENTATION_STATE["slideTransition"]
                PRESENTATION_STATE["cueSeq"] += 1
        elif action == "animEnded":
            req_seq = payload.get("cueSeq")
            if (
                req_seq is not None
                and int(req_seq) == PRESENTATION_STATE["cueSeq"]
                and PRESENTATION_STATE["active"]
                and PRESENTATION_STATE["isAnimation"]
                and not PRESENTATION_STATE["animLoop"]
            ):
                PRESENTATION_STATE["animPlaying"] = False
                if PRESENTATION_STATE["animAutoAdvance"] and PRESENTATION_STATE["playlistActive"]:
                    if (PRESENTATION_STATE["playlistIndex"] + 1) < len(enriched_pl):
                        meta = _activate_playlist_entry_locked(
                            PRESENTATION_STATE["playlistIndex"] + 1, slide_num=1, enriched=enriched_pl
                        )
                        sync_needed = False
        elif action == "animPlay":
            PRESENTATION_STATE["animPlaying"] = True
            if "timeSec" in payload and payload["timeSec"] is not None:
                PRESENTATION_STATE["animSeekSec"] = max(0.0, float(payload["timeSec"]))
            PRESENTATION_STATE["animUpdatedAt"] = time.time()
            PRESENTATION_STATE["animAction"] = "play"
            PRESENTATION_STATE["animActionSeq"] += 1
        elif action == "animPause":
            PRESENTATION_STATE["animPlaying"] = False
            if "timeSec" in payload and payload["timeSec"] is not None:
                PRESENTATION_STATE["animSeekSec"] = max(0.0, float(payload["timeSec"]))
            PRESENTATION_STATE["animUpdatedAt"] = time.time()
            PRESENTATION_STATE["animAction"] = "pause"
            PRESENTATION_STATE["animActionSeq"] += 1
        elif action == "animTogglePlay":
            next_play = not PRESENTATION_STATE["animPlaying"]
            PRESENTATION_STATE["animPlaying"] = next_play
            if "timeSec" in payload and payload["timeSec"] is not None:
                PRESENTATION_STATE["animSeekSec"] = max(0.0, float(payload["timeSec"]))
            PRESENTATION_STATE["animUpdatedAt"] = time.time()
            PRESENTATION_STATE["animAction"] = "play" if next_play else "pause"
            PRESENTATION_STATE["animActionSeq"] += 1
        elif action == "animRestart":
            _reset_anim_playback_locked()
        elif action == "animSeek":
            PRESENTATION_STATE["animSeekSec"] = max(0.0, float(payload.get("timeSec") or 0.0))
            if "playing" in payload:
                PRESENTATION_STATE["animPlaying"] = bool(payload["playing"])
            PRESENTATION_STATE["animUpdatedAt"] = time.time()
            PRESENTATION_STATE["animAction"] = "seek"
            PRESENTATION_STATE["animActionSeq"] += 1
        elif action == "animLoop":
            new_loop = (
                bool(payload["loop"])
                if "loop" in payload
                else not PRESENTATION_STATE["animLoop"]
            )
            PRESENTATION_STATE["animLoop"] = new_loop
            if new_loop:
                PRESENTATION_STATE["animAutoAdvance"] = False
                if not PRESENTATION_STATE["animPlaying"]:
                    PRESENTATION_STATE["animPlaying"] = True
                    PRESENTATION_STATE["animUpdatedAt"] = time.time()
                    PRESENTATION_STATE["animAction"] = "play"
                    PRESENTATION_STATE["animActionSeq"] += 1
            if PRESENTATION_STATE["playlistActive"] and PRESENTATION_STATE["playlistEntryId"]:
                raw_pl = _load_raw_playlist_locked()
                for it in raw_pl:
                    if it.get("entryId") == PRESENTATION_STATE["playlistEntryId"]:
                        it["animBehavior"] = "loop" if new_loop else "once-hold"
                _save_raw_playlist_locked(raw_pl)
            elif meta:
                meta["defaultLoop"] = new_loop
                _save_presentation_meta(meta)
        elif action == "objectFit":
            new_fit = payload.get("objectFit", "cover")
            if new_fit in ("cover", "contain"):
                PRESENTATION_STATE["objectFit"] = new_fit
                if PRESENTATION_STATE["playlistActive"] and PRESENTATION_STATE["playlistEntryId"]:
                    raw_pl = _load_raw_playlist_locked()
                    for it in raw_pl:
                        if it.get("entryId") == PRESENTATION_STATE["playlistEntryId"]:
                            it["objectFit"] = new_fit
                    _save_raw_playlist_locked(raw_pl)
                elif meta:
                    meta["defaultFit"] = new_fit
                    _save_presentation_meta(meta)
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
            if payload.get("slideTransition") in ("fade", "slide-fade", "zoom-fade", "none"):
                PRESENTATION_STATE["slideTransition"] = payload["slideTransition"]
                PRESENTATION_STATE["effectiveTransition"] = payload["slideTransition"]
            if payload.get("subtitleLayoutMode") in ("overlay", "split"):
                PRESENTATION_STATE["subtitleLayoutMode"] = payload["subtitleLayoutMode"]
            if payload.get("subtitlePosition") in ("bottom", "top", "center"):
                PRESENTATION_STATE["subtitlePosition"] = payload["subtitlePosition"]
            if "subtitleOpacity" in payload:
                PRESENTATION_STATE["subtitleOpacity"] = max(0.0, min(0.95, float(payload["subtitleOpacity"])))
            if "subtitleFontScale" in payload:
                PRESENTATION_STATE["subtitleFontScale"] = max(0.55, min(1.5, float(payload["subtitleFontScale"])))
            if "subtitleAreaHeightPct" in payload:
                PRESENTATION_STATE["subtitleAreaHeightPct"] = max(10, min(45, int(round(float(payload["subtitleAreaHeightPct"])))))
            if "subtitleAreaWidthPct" in payload:
                PRESENTATION_STATE["subtitleAreaWidthPct"] = max(50, min(100, int(round(float(payload["subtitleAreaWidthPct"])))))
            if "nativeMonitorIndex" in payload:
                PRESENTATION_STATE["nativeMonitorIndex"] = int(payload["nativeMonitorIndex"])

        if sync_needed and meta:
            _sync_slide_fields_locked(meta, enriched_playlist=enriched_pl)

        PRESENTATION_STATE["version"] += 1
        state_snap = dict(PRESENTATION_STATE)
        state_snap["serverNow"] = time.time()

    # Obsługa natywnego PowerPointa oraz nakładki poza lockiem
    if action == "nativeStart" and meta and not meta.get("isAnimation"):
        with PRES_LOCK:
            PRESENTATION_STATE["mode"] = "native"
            PRESENTATION_STATE["active"] = True
            PRESENTATION_STATE["version"] += 1
            mon_idx = PRESENTATION_STATE["nativeMonitorIndex"]
        threading.Thread(
            target=_native_ppt_command,
            args=("start", meta.get("sourcePath")),
            kwargs={"monitor_index": mon_idx},
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

    if state_snap["mode"] == "native" and not state_snap.get("isAnimation") and action in ("next", "prev", "goto", "blackout"):
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
        snap = dict(PRESENTATION_STATE)
        snap["serverNow"] = time.time()
        return snap
