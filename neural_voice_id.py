#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
neural_voice_id.py
Lokalny silnik biometrii głosu oparty na głębokiej sieci neuronowej WeSpeaker CAM++ (ONNX Runtime).
Wyodrębnia 512-wymiarowy wektor tożsamości głosowej (d-vector / x-vector) niezależny od wymawianych słów
oraz odporny na zbliżoną wysokość głosu (F0) u różnych mężczyzn.
"""

import base64
import importlib.util
import os
import shutil
import threading
import urllib.request
import numpy as np

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
VC_REDIST_DIR = os.path.join(MODEL_DIR, "vc_redist")
MODEL_PATH = os.path.join(MODEL_DIR, "wespeaker_campp.onnx")
MODEL_URL = "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_CAM++_LM.onnx"

_DLL_HANDLES = []


def _ensure_windows_vc_runtime_dlls():
    """
    Zapewnia obecność bibliotek Microsoft Visual C++ Redistributable (msvcp140.dll, vcruntime140_1.dll itp.)
    wymaganych przez onnxruntime_pybind11_state.pyd na świeżych instalacjach Windows 10/11 (nawet bez praw Admina).
    """
    if os.name != "nt" or not os.path.isdir(VC_REDIST_DIR):
        return
    try:
        os.environ["PATH"] = VC_REDIST_DIR + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            _DLL_HANDLES.append(os.add_dll_directory(VC_REDIST_DIR))
        spec = importlib.util.find_spec("onnxruntime")
        if spec and spec.submodule_search_locations:
            ort_capi_dir = os.path.join(spec.submodule_search_locations[0], "capi")
            if os.path.isdir(ort_capi_dir):
                for fname in os.listdir(VC_REDIST_DIR):
                    if fname.lower().endswith(".dll"):
                        src = os.path.join(VC_REDIST_DIR, fname)
                        dst = os.path.join(ort_capi_dir, fname)
                        if not os.path.exists(dst):
                            shutil.copy2(src, dst)
    except Exception as e:
        print(f"[Voice-ID AI] Ostrzezenie przy rejestracji DLL VC++: {e}")

_SESSION_LOCK = threading.Lock()
_ORT_SESSION = None
_MEL_BANKS_80 = None
_POVEY_WINDOW_400 = None


def _init_dsp_constants():
    global _MEL_BANKS_80, _POVEY_WINDOW_400
    if _MEL_BANKS_80 is not None and _POVEY_WINDOW_400 is not None:
        return

    # 1. Okno Kaldi Povey dla ramki 25ms (400 próbek przy 16000 Hz)
    n = np.arange(400, dtype=np.float32)
    _POVEY_WINDOW_400 = np.power(0.5 - 0.5 * np.cos(2.0 * np.pi * n / 399.0), 0.85).astype(np.float32)

    # 2. Macierz 80 trójkątnych filtrów Mel (20 Hz - 7600 Hz) zgodna ze standardem Kaldi Fbank
    num_bins = 80
    sample_rate = 16000.0
    fft_size = 512
    num_fft_bins = fft_size // 2 + 1  # 257

    def hz_to_mel(f):
        return 1127.0 * np.log(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (np.exp(m / 1127.0) - 1.0)

    low_mel = hz_to_mel(20.0)
    high_mel = hz_to_mel(7600.0)
    mel_points = np.linspace(low_mel, high_mel, num_bins + 2, dtype=np.float32)
    hz_points = mel_to_hz(mel_points)

    fft_freqs = np.linspace(0.0, sample_rate / 2.0, num_fft_bins, dtype=np.float32)
    banks = np.zeros((num_fft_bins, num_bins), dtype=np.float32)

    for b in range(num_bins):
        left_hz = hz_points[b]
        center_hz = hz_points[b + 1]
        right_hz = hz_points[b + 2]

        up_slope = (fft_freqs - left_hz) / max(1e-5, center_hz - left_hz)
        down_slope = (right_hz - fft_freqs) / max(1e-5, right_hz - center_hz)
        banks[:, b] = np.maximum(0.0, np.minimum(up_slope, down_slope))

    _MEL_BANKS_80 = banks


def get_ort_session():
    global _ORT_SESSION
    if _ORT_SESSION is not None:
        return _ORT_SESSION

    with _SESSION_LOCK:
        if _ORT_SESSION is not None:
            return _ORT_SESSION

        _ensure_windows_vc_runtime_dlls()
        import onnxruntime as ort
        os.makedirs(MODEL_DIR, exist_ok=True)
        if not os.path.exists(MODEL_PATH) or os.path.getsize(MODEL_PATH) < 1_000_000:
            print("[Voice-ID AI] Pobieranie modelu neuronowego WeSpeaker CAM++ ONNX...")
            urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
            print("[Voice-ID AI] Model WeSpeaker CAM++ gotowy.")

        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = 2
        sess_options.inter_op_num_threads = 1
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        _ORT_SESSION = ort.InferenceSession(
            MODEL_PATH,
            sess_options=sess_options,
            providers=["CPUExecutionProvider"]
        )
        _init_dsp_constants()
        return _ORT_SESSION


def extract_kaldi_fbank_80(samples_16k: np.ndarray) -> np.ndarray:
    """
    Przekształca jednowymiarowy sygnał float32 (16kHz, [-1, 1]) na macierz cech Kaldi Fbank (T, 80)
    z odrzuceniem ciszy (VAD) oraz normalizacją CMN.
    """
    _init_dsp_constants()

    # Skalowanie do 16-bit PCM zgodnie z wymogiem WeSpeaker (normalize_samples = 0)
    wav = np.asarray(samples_16k, dtype=np.float32) * 32768.0
    if wav.shape[0] < 400:
        return np.empty((0, 80), dtype=np.float32)

    # Podział na ramki 400 próbek (25ms) z krokiem 160 próbek (10ms)
    num_frames = 1 + (wav.shape[0] - 400) // 160
    strides = (wav.strides[0] * 160, wav.strides[0])
    frames = np.lib.stride_tricks.as_strided(wav, shape=(num_frames, 400), strides=strides).copy()

    # Bramka szumów / VAD: odrzuć ramki ciszy, aby pauzy między słowami nie rozmywały wektora głosu
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-6)
    p90_rms = np.percentile(frame_rms, 90)
    if p90_rms < 180.0:  # Zbyt ciche całe nagranie (< ~0.0055 w skali [-1, 1])
        return np.empty((0, 80), dtype=np.float32)

    voiced_mask = frame_rms >= max(130.0, p90_rms * 0.16)
    voiced_frames = frames[voiced_mask]
    if voiced_frames.shape[0] < 10:  # Wystarczy już ~0.12s czystych ramek głosowych do szybkiego startu
        return np.empty((0, 80), dtype=np.float32)

    # Usunięcie składowej stałej (DC offset)
    voiced_frames -= np.mean(voiced_frames, axis=1, keepdims=True)

    # Pre-emfaza 0.97
    emphasized = np.empty_like(voiced_frames)
    emphasized[:, 0] = voiced_frames[:, 0] * 0.03
    emphasized[:, 1:] = voiced_frames[:, 1:] - 0.97 * voiced_frames[:, :-1]

    # Okienkowanie Povey + FFT 512
    windowed = emphasized * _POVEY_WINDOW_400[None, :]
    spec = np.fft.rfft(windowed, n=512, axis=1)
    power_spec = (spec.real * spec.real + spec.imag * spec.imag).astype(np.float32)

    # 80 pasm Mel + logarytm
    mel_energies = np.matmul(power_spec, _MEL_BANKS_80)
    log_mel = np.log(np.maximum(mel_energies, 1e-7))

    # Cepstral Mean Normalization (CMN) wzdłuż osi czasu — uniezależnia od charakterystyki mikrofonu
    log_mel -= np.mean(log_mel, axis=0, keepdims=True)
    return log_mel.astype(np.float32)


def estimate_median_pitch_hz(samples_16k: np.ndarray) -> int:
    """
    Szybka estymacja mediany tonu podstawowego F0 (w Hz) do wyświetlenia w telemetrii operatora.
    """
    wav = np.asarray(samples_16k, dtype=np.float32)
    sr = 16000
    frame_len = 1024
    hop = 512
    if wav.shape[0] < frame_len:
        return 0

    min_lag = int(sr / 340)  # ~47
    max_lag = int(sr / 70)   # ~228
    pitches = []

    for start in range(0, wav.shape[0] - frame_len, hop):
        chunk = wav[start:start + frame_len]
        rms = float(np.sqrt(np.mean(chunk * chunk)))
        if rms < 0.015:
            continue
        chunk = chunk - np.mean(chunk)
        # Autokorelacja przez FFT
        fft_c = np.fft.rfft(chunk, n=2048)
        acf = np.fft.irfft(fft_c * np.conj(fft_c), n=2048)[:max_lag + 2]
        if acf[0] <= 1e-7:
            continue
        norm_acf = acf / acf[0]
        region = norm_acf[min_lag:max_lag + 1]
        best_idx = int(np.argmax(region))
        best_val = float(region[best_idx])
        if best_val >= 0.45:
            lag = min_lag + best_idx
            pitches.append(sr / float(lag))

    if not pitches:
        return 0
    return int(round(float(np.median(pitches))))


def extract_neural_embedding_from_pcm16_base64(pcm16_b64: str) -> dict:
    """
    Przyjmuje zakodowany w Base64 strumień Int16 PCM (16000 Hz Mono),
    uruchamia model neuronowy WeSpeaker CAM++ ONNX i zwraca 512-wymiarowy znormalizowany wektor głosu.
    """
    raw_bytes = base64.b64decode(pcm16_b64)
    pcm_int16 = np.frombuffer(raw_bytes, dtype=np.int16)
    samples_f32 = pcm_int16.astype(np.float32) / 32768.0

    fbank = extract_kaldi_fbank_80(samples_f32)
    if fbank.shape[0] < 10:
        return {
            "ok": False,
            "voicedFrames": int(fbank.shape[0]),
            "reason": "silence_or_too_short"
        }

    sess = get_ort_session()
    feats_input = fbank[None, :, :]  # (1, T, 80)
    embs = sess.run(None, {"feats": feats_input})[0]  # (1, 512)
    vec = embs[0].astype(np.float32)

    norm = float(np.linalg.norm(vec))
    if norm > 1e-8:
        vec = vec / norm

    pitch_hz = estimate_median_pitch_hz(samples_f32)

    return {
        "ok": True,
        "embedding": [round(float(x), 5) for x in vec.tolist()],
        "dim": int(vec.shape[0]),
        "voicedFrames": int(fbank.shape[0]),
        "pitchHz": pitch_hz
    }
