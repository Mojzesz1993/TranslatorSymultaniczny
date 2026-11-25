/**
 * screen.js
 * Logika Ekranu Prezentacji (dla publiczności / rzutnika / telebimu / OBS).
 * Obsługuje również funkcję renderStageDOM wykorzystywaną w podglądzie na żywo u Operatora.
 */

import {
  SyncManager,
  loadBackgroundMedia,
  buildTextShadowCSS,
  hexToRgba
} from './sync.js';

const SLIDE_IN_CLASSES = [
  'slide-trans-in-fade',
  'slide-trans-in-slide-next',
  'slide-trans-in-slide-prev',
  'slide-trans-in-zoom-fade'
];

/**
 * Odtwarzacz animowanych obrazów (GIF / animowany WebP) oparty na WebCodecs ImageDecoder.
 * Zapewnia pełne Play/Pause, Restart, Seek (przewijanie), odczyt czasu oraz zatrzymanie
 * dokładnie na ostatniej klatce, gdy Loop jest wyłączony.
 */
export class AnimatedImageCanvasPlayer {
  constructor(canvas, onEnded = null) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.onEnded = onEnded;
    this.url = null;
    this.decoder = null;
    this.frameCount = 0;
    this.durationsSec = [];
    this.cumTimesSec = [];
    this.totalDurationSec = 0;
    this.currentTimeSec = 0;
    this.currentFrameIdx = -1;
    this.loop = true;
    this.playing = true;
    this.ended = false;
    this._rafId = null;
    this._lastTickMs = 0;
    this._decodeToken = 0;
    this._renderingFrame = false;
    this._fallbackImg = null;
  }

  async load(url, { loop = true, playing = true, startTimeSec = 0 } = {}) {
    this.stopRaf();
    this._closeDecoder();
    this.url = url;
    this.loop = Boolean(loop);
    this.playing = Boolean(playing);
    this.ended = false;
    this.currentTimeSec = Math.max(0, Number(startTimeSec) || 0);
    this.currentFrameIdx = -1;
    this.durationsSec = [];
    this.cumTimesSec = [];
    this.totalDurationSec = 0;
    const token = ++this._decodeToken;

    if (!url || !this.canvas || !this.ctx) return;

    if (typeof window.ImageDecoder === 'function') {
      try {
        const res = await fetch(url);
        if (token !== this._decodeToken) return;
        const contentType = res.headers.get('Content-Type') || (url.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/gif');
        const buf = await res.arrayBuffer();
        if (token !== this._decodeToken) return;

        const decoder = new window.ImageDecoder({ data: buf, type: contentType });
        await decoder.tracks.ready;
        if (token !== this._decodeToken) {
          decoder.close();
          return;
        }
        const track = decoder.tracks.selectedTrack;
        const count = Math.max(1, track ? track.frameCount : 1);
        this.decoder = decoder;
        this.frameCount = count;

        const durs = [];
        const cums = [];
        let acc = 0;
        for (let i = 0; i < count; i++) {
          const decoded = await decoder.decode({ frameIndex: i });
          if (token !== this._decodeToken) {
            decoded.image.close();
            decoder.close();
            return;
          }
          if (i === 0) {
            this.canvas.width = decoded.image.displayWidth || decoded.image.codedWidth || 1280;
            this.canvas.height = decoded.image.displayHeight || decoded.image.codedHeight || 720;
          }
          // Czas trwania klatki w mikrosekundach -> sekundy (domyślnie 80ms gdy 0)
          const durSec = decoded.image.duration ? Math.max(0.02, decoded.image.duration / 1_000_000) : 0.08;
          durs.push(durSec);
          cums.push(acc);
          acc += durSec;
          decoded.image.close();
        }

        this.durationsSec = durs;
        this.cumTimesSec = cums;
        this.totalDurationSec = count > 1 ? acc : 0;

        if (this.totalDurationSec > 0 && this.currentTimeSec > 0) {
          if (this.loop) {
            this.currentTimeSec = this.currentTimeSec % this.totalDurationSec;
          } else if (this.currentTimeSec >= this.totalDurationSec) {
            this.currentTimeSec = this.totalDurationSec;
            this.playing = false;
            this.ended = true;
          }
        }

        await this._renderFrameAtTime(this.currentTimeSec, token);
        if (this.playing && this.frameCount > 1) {
          this._startRaf();
        }
        return;
      } catch (_) {
        // Fallback do statycznego wyrysowania obrazu jeśli ImageDecoder odrzuci plik
      }
    }

    // Fallback: zwykły obiekt Image narysowany na canvasie
    const img = new Image();
    this._fallbackImg = img;
    img.onload = () => {
      if (token !== this._decodeToken || !this.canvas || !this.ctx) return;
      this.canvas.width = img.naturalWidth || 1280;
      this.canvas.height = img.naturalHeight || 720;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    };
    img.src = url;
  }

  _findFrameIndex(timeSec) {
    if (this.frameCount <= 1 || this.cumTimesSec.length === 0) return 0;
    if (timeSec >= this.totalDurationSec) return this.frameCount - 1;
    let lo = 0;
    let hi = this.frameCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.cumTimesSec[mid];
      const end = start + this.durationsSec[mid];
      if (timeSec < start) {
        hi = mid - 1;
      } else if (timeSec >= end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return Math.max(0, Math.min(this.frameCount - 1, lo));
  }

  async _renderFrameAtTime(timeSec, token = this._decodeToken) {
    if (!this.decoder || !this.ctx || !this.canvas || this._renderingFrame) return;
    const idx = this._findFrameIndex(timeSec);
    if (idx === this.currentFrameIdx) return;
    this._renderingFrame = true;
    try {
      const { image } = await this.decoder.decode({ frameIndex: idx });
      if (token === this._decodeToken && this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
        this.currentFrameIdx = idx;
      }
      image.close();
    } catch (_) {
      // ignore decode race
    } finally {
      this._renderingFrame = false;
    }
  }

  _startRaf() {
    this.stopRaf();
    this._lastTickMs = performance.now();
    const tick = (nowMs) => {
      if (!this.playing || !this.decoder || this.frameCount <= 1 || this.totalDurationSec <= 0) {
        this._rafId = null;
        return;
      }
      const dt = Math.max(0, Math.min(0.25, (nowMs - this._lastTickMs) / 1000));
      this._lastTickMs = nowMs;
      let nextTime = this.currentTimeSec + dt;

      if (nextTime >= this.totalDurationSec) {
        if (this.loop) {
          nextTime = nextTime % this.totalDurationSec;
          this.ended = false;
        } else {
          this.currentTimeSec = this.totalDurationSec;
          this.playing = false;
          this.ended = true;
          this._rafId = null;
          this._renderFrameAtTime(this.totalDurationSec);
          if (typeof this.onEnded === 'function') {
            this.onEnded();
          }
          return;
        }
      }

      this.currentTimeSec = nextTime;
      this._renderFrameAtTime(this.currentTimeSec);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stopRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  play() {
    if (this.ended && this.totalDurationSec > 0) {
      this.currentTimeSec = 0;
      this.currentFrameIdx = -1;
      this.ended = false;
    }
    this.playing = true;
    if (this.decoder && this.frameCount > 1 && !this._rafId) {
      this._startRaf();
    }
  }

  pause() {
    this.playing = false;
    this.stopRaf();
  }

  restart() {
    this.currentTimeSec = 0;
    this.currentFrameIdx = -1;
    this.ended = false;
    this.playing = true;
    this._renderFrameAtTime(0);
    if (this.decoder && this.frameCount > 1) {
      this._startRaf();
    }
  }

  seek(timeSec) {
    const dur = this.totalDurationSec || 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(dur, Number(timeSec) || 0)) : 0;
    this.currentTimeSec = clamped;
    this.ended = !this.loop && dur > 0 && clamped >= dur;
    this.currentFrameIdx = -1;
    this._renderFrameAtTime(clamped);
    if (this.playing && !this.ended && this.decoder && this.frameCount > 1 && !this._rafId) {
      this._startRaf();
    }
  }

  setLoop(loopVal) {
    const nextLoop = Boolean(loopVal);
    this.loop = nextLoop;
    if (nextLoop && this.ended) {
      this.ended = false;
      this.currentTimeSec = 0;
      this.currentFrameIdx = -1;
      this.play();
    }
  }

  destroy() {
    this._decodeToken++;
    this.stopRaf();
    this._closeDecoder();
    this.url = null;
  }

  _closeDecoder() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (_) {}
      this.decoder = null;
    }
  }
}

/**
 * Tworzy element migawki wychodzącego slajdu / klatki wideo / canvasu do płynnego przejścia CSS.
 */
function createOutgoingMediaSnapshot(sourceEl, outClass) {
  if (!sourceEl) return null;
  const rect = sourceEl.getBoundingClientRect();
  const w = Math.max(320, Math.round(rect.width || 1280));
  const h = Math.max(180, Math.round(rect.height || 720));

  try {
    let mediaW = 0;
    let mediaH = 0;
    if (sourceEl.tagName === 'VIDEO') {
      mediaW = sourceEl.videoWidth;
      mediaH = sourceEl.videoHeight;
    } else if (sourceEl.tagName === 'CANVAS') {
      mediaW = sourceEl.width;
      mediaH = sourceEl.height;
    } else if (sourceEl.tagName === 'IMG') {
      mediaW = sourceEl.naturalWidth;
      mediaH = sourceEl.naturalHeight;
    }

    if (mediaW > 0 && mediaH > 0) {
      const snap = document.createElement('canvas');
      snap.width = w;
      snap.height = h;
      snap.className = `stage-bg-media stage-slide-outgoing ${outClass}`;
      snap.style.top = sourceEl.style.top || '0';
      snap.style.height = sourceEl.style.height || '100%';
      const ctx = snap.getContext('2d');
      const fit = sourceEl.style.objectFit || 'contain';

      if (fit === 'cover') {
        const scale = Math.max(w / mediaW, h / mediaH);
        const dw = mediaW * scale;
        const dh = mediaH * scale;
        ctx.drawImage(sourceEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        const scale = Math.min(w / mediaW, h / mediaH);
        const dw = mediaW * scale;
        const dh = mediaH * scale;
        ctx.drawImage(sourceEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
      return snap;
    }
  } catch (_) {
    // Fallback dla obrazów gdy canvas niedostępny
  }

  if (sourceEl.tagName === 'IMG' && sourceEl.src) {
    const outgoing = document.createElement('img');
    outgoing.className = `stage-bg-media stage-slide-outgoing ${outClass}`;
    outgoing.alt = '';
    outgoing.style.objectFit = sourceEl.style.objectFit || 'contain';
    outgoing.style.background = 'transparent';
    outgoing.src = sourceEl.src;
    return outgoing;
  }
  return null;
}

function getTransitionClasses(transitionType, isForward) {
  let inClass = 'slide-trans-in-fade';
  let outClass = 'slide-trans-out-fade';
  if (transitionType === 'slide-fade') {
    inClass = isForward ? 'slide-trans-in-slide-next' : 'slide-trans-in-slide-prev';
    outClass = isForward ? 'slide-trans-out-slide-next' : 'slide-trans-out-slide-prev';
  } else if (transitionType === 'zoom-fade') {
    inClass = 'slide-trans-in-zoom-fade';
    outClass = 'slide-trans-out-zoom-fade';
  }
  return { inClass, outClass };
}

export function runElementTransition(container, incomingEl, outgoingSnapshotSource, transitionType = 'fade', isForward = true) {
  if (!container || !incomingEl) return;
  container.querySelectorAll('.stage-slide-outgoing').forEach((el) => el.remove());
  incomingEl.classList.remove(...SLIDE_IN_CLASSES);
  if (container._transTimer) {
    clearTimeout(container._transTimer);
    container._transTimer = null;
  }

  if (!outgoingSnapshotSource || transitionType === 'none') {
    return;
  }

  const { inClass, outClass } = getTransitionClasses(transitionType, isForward);
  const snap = createOutgoingMediaSnapshot(outgoingSnapshotSource, outClass);
  if (snap) {
    container.insertBefore(snap, incomingEl);
  }
  void incomingEl.offsetWidth;
  incomingEl.classList.add(inClass);

  container._transTimer = setTimeout(() => {
    if (snap) snap.remove();
    incomingEl.classList.remove(inClass);
    container._transTimer = null;
  }, 760);
}

export function applySlideTransition(container, slideImg, newUrl, transitionType = 'fade', isForward = true, wasVisible = true) {
  if (!container || !slideImg) return;

  const oldUrl = slideImg.getAttribute('data-src');
  slideImg.setAttribute('data-src', newUrl);
  slideImg._pendingUrl = newUrl;

  if (transitionType === 'none' || !oldUrl || !wasVisible) {
    container.querySelectorAll('.stage-slide-outgoing').forEach((el) => el.remove());
    slideImg.classList.remove(...SLIDE_IN_CLASSES);
    if (slideImg._transTimer) {
      clearTimeout(slideImg._transTimer);
      slideImg._transTimer = null;
    }
    slideImg.src = newUrl;
    return;
  }

  const { inClass, outClass } = getTransitionClasses(transitionType, isForward);

  const preloader = new Image();
  preloader.src = newUrl;

  const runAnimation = () => {
    if (slideImg._pendingUrl !== newUrl) return;

    container.querySelectorAll('.stage-slide-outgoing').forEach((el) => el.remove());
    slideImg.classList.remove(...SLIDE_IN_CLASSES);
    if (slideImg._transTimer) {
      clearTimeout(slideImg._transTimer);
      slideImg._transTimer = null;
    }

    const outgoing = createOutgoingMediaSnapshot(slideImg, outClass);
    if (outgoing) {
      container.insertBefore(outgoing, slideImg);
    }

    slideImg.src = newUrl;
    requestAnimationFrame(() => {
      if (slideImg._pendingUrl !== newUrl) {
        if (outgoing) outgoing.remove();
        return;
      }
      void slideImg.offsetWidth;
      slideImg.classList.add(inClass);

      slideImg._transTimer = setTimeout(() => {
        if (outgoing) outgoing.remove();
        slideImg.classList.remove(inClass);
        slideImg._transTimer = null;
      }, 760);
    });
  };

  if (typeof preloader.decode === 'function') {
    preloader.decode().then(runAnimation, runAnimation);
  } else if (preloader.complete) {
    runAnimation();
  } else {
    preloader.onload = runAnimation;
    preloader.onerror = runAnimation;
  }
}

/**
 * Wspólna funkcja synchronizująca warstwę slajdu / animacji (obraz statyczny, wideo MP4/WebM/MOV lub GIF/WebP)
 * na scenie głównej, mini-podglądzie operatora oraz monitorze Panelu Slajdów.
 */
export function renderSlideOrAnimationMedia(container, mediaEls, presState, options = {}) {
  const { slideImg, slideVideo, slideCanvas } = mediaEls;
  const { onAnimEnded = null } = options;

  if (!container || !presState || !presState.currentSlideUrl || presState.blackoutSlide) {
    if (slideImg) slideImg.classList.add('hidden');
    if (slideVideo) {
      slideVideo.classList.add('hidden');
      slideVideo.pause();
    }
    if (slideCanvas) {
      slideCanvas.classList.add('hidden');
      if (slideCanvas._animPlayer) slideCanvas._animPlayer.pause();
    }
    container._activeMediaEl = null;
    return;
  }

  const mediaType = presState.currentMediaType || 'image';
  const fit = presState.objectFit || (presState.isAnimation ? 'cover' : 'contain');
  const cueKey = `${presState.presentationId || ''}|${presState.currentSlide || 1}|${presState.cueSeq || 0}|${presState.currentSlideUrl}`;
  const prevCueKey = container._lastCueKey || '';
  const isNewCue = cueKey !== prevCueKey;
  const prevVisibleEl = container._activeMediaEl;

  const prevOrder = Number(container._lastOrderVal || 0);
  const curOrder = (Number(presState.playlistIndex ?? 0) * 10000) + Number(presState.currentSlide || 1);
  const isForward = prevOrder === 0 || curOrder >= prevOrder;
  container._lastOrderVal = curOrder;

  const transType = presState.effectiveTransition || presState.slideTransition || 'fade';

  let activeEl = slideImg;
  if (mediaType === 'video' && slideVideo) activeEl = slideVideo;
  else if (mediaType === 'anim-image' && slideCanvas) activeEl = slideCanvas;

  // Zastosuj dopasowanie kadru
  if (activeEl) {
    activeEl.style.objectFit = fit;
  }

  if (isNewCue) {
    const isInitialMount = !prevCueKey;
    container._lastCueKey = cueKey;
    container._lastAnimSeq = presState.animActionSeq;

    // Oblicz pozycję startową jeśli dołączamy do już trwającej animacji
    let initialSeekSec = Number(presState.animSeekSec || 0);
    if (isInitialMount && presState.isAnimation && presState.animPlaying && presState.serverNow && presState.animUpdatedAt) {
      initialSeekSec += Math.max(0, Number(presState.serverNow) - Number(presState.animUpdatedAt));
    }

    if (mediaType === 'video' && slideVideo) {
      if (prevVisibleEl && prevVisibleEl !== slideVideo) {
        runElementTransition(container, slideVideo, prevVisibleEl, transType, isForward);
      } else if (prevVisibleEl === slideVideo) {
        runElementTransition(container, slideVideo, slideVideo, transType, isForward);
      }
      if (slideImg) slideImg.classList.add('hidden');
      if (slideCanvas) {
        slideCanvas.classList.add('hidden');
        if (slideCanvas._animPlayer) slideCanvas._animPlayer.pause();
      }
      slideVideo.classList.remove('hidden');
      slideVideo.muted = true;
      slideVideo.volume = 0;
      slideVideo.loop = Boolean(presState.animLoop);

      slideVideo.onended = () => {
        if (!slideVideo.loop && typeof onAnimEnded === 'function') {
          onAnimEnded(presState.cueSeq);
        }
      };

      const targetUrl = presState.currentSlideUrl;
      const applyVideoStart = () => {
        slideVideo.muted = true;
        slideVideo.loop = Boolean(presState.animLoop);
        if (initialSeekSec > 0.05 && Number.isFinite(slideVideo.duration) && slideVideo.duration > 0) {
          slideVideo.currentTime = slideVideo.loop
            ? (initialSeekSec % slideVideo.duration)
            : Math.min(slideVideo.duration, initialSeekSec);
        } else {
          try {
            slideVideo.currentTime = 0;
          } catch (_) {}
        }
        if (presState.animPlaying !== false) {
          slideVideo.play().catch(() => {});
        } else {
          slideVideo.pause();
        }
      };

      if (slideVideo.getAttribute('data-src') !== targetUrl) {
        slideVideo.setAttribute('data-src', targetUrl);
        slideVideo.src = targetUrl;
        slideVideo.addEventListener('loadedmetadata', applyVideoStart, { once: true });
        slideVideo.load();
      } else {
        applyVideoStart();
      }
      container._activeMediaEl = slideVideo;
    } else if (mediaType === 'anim-image' && slideCanvas) {
      if (prevVisibleEl) {
        runElementTransition(container, slideCanvas, prevVisibleEl, transType, isForward);
      }
      if (slideImg) slideImg.classList.add('hidden');
      if (slideVideo) {
        slideVideo.classList.add('hidden');
        slideVideo.pause();
      }
      slideCanvas.classList.remove('hidden');

      if (!slideCanvas._animPlayer) {
        slideCanvas._animPlayer = new AnimatedImageCanvasPlayer(slideCanvas);
      }
      const player = slideCanvas._animPlayer;
      const capturedSeq = presState.cueSeq;
      player.onEnded = () => {
        if (!player.loop && typeof onAnimEnded === 'function') {
          onAnimEnded(capturedSeq);
        }
      };
      player.load(presState.currentSlideUrl, {
        loop: Boolean(presState.animLoop),
        playing: presState.animPlaying !== false,
        startTimeSec: initialSeekSec,
      });
      container._activeMediaEl = slideCanvas;
    } else if (slideImg) {
      if (slideVideo) {
        slideVideo.classList.add('hidden');
        slideVideo.pause();
      }
      if (slideCanvas) {
        slideCanvas.classList.add('hidden');
        if (slideCanvas._animPlayer) slideCanvas._animPlayer.pause();
      }
      slideImg.classList.remove('hidden');

      if (prevVisibleEl && prevVisibleEl !== slideImg) {
        slideImg.setAttribute('data-src', presState.currentSlideUrl);
        slideImg.src = presState.currentSlideUrl;
        runElementTransition(container, slideImg, prevVisibleEl, transType, isForward);
      } else {
        applySlideTransition(
          container,
          slideImg,
          presState.currentSlideUrl,
          transType,
          isForward,
          Boolean(prevVisibleEl === slideImg)
        );
      }
      container._activeMediaEl = slideImg;
    }

    // Preload kolejnego statycznego slajdu
    if (presState.nextSlideUrl && presState.nextSlideMediaType === 'image' && slideImg && slideImg._preloadedNextUrl !== presState.nextSlideUrl) {
      slideImg._preloadedNextUrl = presState.nextSlideUrl;
      const nextPreload = new Image();
      nextPreload.src = presState.nextSlideUrl;
      if (typeof nextPreload.decode === 'function') {
        nextPreload.decode().catch(() => {});
      }
    }
    return;
  }

  // Ten sam slajd/animacja — zsynchronizuj przełącznik Loop, Fit oraz akcje paska transportu (Play/Pause/Seek/Restart)
  if (mediaType === 'video' && slideVideo) {
    slideVideo.classList.remove('hidden');
    slideVideo.muted = true;
    const wantLoop = Boolean(presState.animLoop);
    if (slideVideo.loop !== wantLoop) {
      slideVideo.loop = wantLoop;
      if (wantLoop && slideVideo.ended) {
        slideVideo.currentTime = 0;
        slideVideo.play().catch(() => {});
      }
    }

    if (container._lastAnimSeq !== presState.animActionSeq) {
      container._lastAnimSeq = presState.animActionSeq;
      const act = presState.animAction;
      const targetSec = Number(presState.animSeekSec || 0);
      if (act === 'restart') {
        slideVideo.currentTime = 0;
        slideVideo.play().catch(() => {});
      } else if (act === 'pause') {
        if (Number.isFinite(targetSec) && Math.abs(slideVideo.currentTime - targetSec) > 0.35) {
          slideVideo.currentTime = targetSec;
        }
        slideVideo.pause();
      } else if (act === 'play') {
        if (slideVideo.ended || (Number.isFinite(slideVideo.duration) && slideVideo.currentTime >= slideVideo.duration - 0.05)) {
          slideVideo.currentTime = 0;
        } else if (Number.isFinite(targetSec) && Math.abs(slideVideo.currentTime - targetSec) > 0.5) {
          slideVideo.currentTime = targetSec;
        }
        slideVideo.play().catch(() => {});
      } else if (act === 'seek') {
        if (Number.isFinite(slideVideo.duration) && slideVideo.duration > 0) {
          slideVideo.currentTime = Math.max(0, Math.min(slideVideo.duration, targetSec));
        } else {
          slideVideo.currentTime = Math.max(0, targetSec);
        }
        if (presState.animPlaying !== false) {
          slideVideo.play().catch(() => {});
        } else {
          slideVideo.pause();
        }
      }
    }
  } else if (mediaType === 'anim-image' && slideCanvas && slideCanvas._animPlayer) {
    slideCanvas.classList.remove('hidden');
    const player = slideCanvas._animPlayer;
    player.setLoop(Boolean(presState.animLoop));

    if (container._lastAnimSeq !== presState.animActionSeq) {
      container._lastAnimSeq = presState.animActionSeq;
      const act = presState.animAction;
      const targetSec = Number(presState.animSeekSec || 0);
      if (act === 'restart') {
        player.restart();
      } else if (act === 'pause') {
        if (Math.abs(player.currentTimeSec - targetSec) > 0.35) {
          player.seek(targetSec);
        }
        player.pause();
      } else if (act === 'play') {
        if (Math.abs(player.currentTimeSec - targetSec) > 0.5 && !player.ended) {
          player.seek(targetSec);
        }
        player.play();
      } else if (act === 'seek') {
        player.seek(targetSec);
        if (presState.animPlaying !== false) player.play();
        else player.pause();
      }
    }
  } else if (slideImg) {
    slideImg.classList.remove('hidden');
  }
}

/**
 * Funkcja renderująca stan i wygląd ekranu prezentacji na dowolnym zestawie elementów DOM
 * (używana zarówno w pełnoekranowym screen.html, jak i w miniaturowym podglądzie w index.html).
 */
export function renderStageDOM(dom, settings, liveState, bgRecord, scaleFactor = 1, presState = null, stageCallbacks = {}) {
  const {
    bgLayer,
    bgImage,
    bgVideo,
    slideImg,
    slideVideo,
    slideCanvas,
    bgOverlay,
    safeArea,
    customBanner,
    bannerTitle,
    bannerSubtitle,
    subtitlesContainer,
    speakerBadge,
    linesWrapper
  } = dom;

  const isBrowserSlideActive = Boolean(presState && presState.active && presState.mode === 'browser' && presState.presentationId);

  // 1. Konfiguracja Tła (lub aktywnego slajdu / animacji z Panelu Slajdów)
  const bgType = settings.bgType || 'gradient';
  bgLayer.style.background = '#090D16';
  bgImage.classList.add('hidden');
  bgVideo.classList.add('hidden');

  const stageParent = bgLayer.parentElement;

  if (isBrowserSlideActive) {
    const unifiedSlideBg =
      bgType === 'gradient' && settings.bgGradient
        ? settings.bgGradient
        : 'linear-gradient(160deg, #060B19 0%, #0F172A 52%, #1E1B4B 100%)';
    if (stageParent) stageParent.style.background = unifiedSlideBg;
    bgLayer.style.background = 'transparent';
    renderSlideOrAnimationMedia(
      bgLayer,
      { slideImg, slideVideo, slideCanvas },
      presState,
      { onAnimEnded: stageCallbacks.onAnimEnded || null }
    );
    bgOverlay.style.background = 'transparent';
  } else {
    renderSlideOrAnimationMedia(bgLayer, { slideImg, slideVideo, slideCanvas }, null);
    bgLayer._lastCueKey = '';
    if (stageParent) stageParent.style.background = '';
    if (bgType === 'color') {
      bgLayer.style.background = settings.bgColor || '#090D16';
    } else if (bgType === 'gradient') {
      bgLayer.style.background = settings.bgGradient || 'linear-gradient(135deg, #060B19 0%, #0F172A 50%, #1E1B4B 100%)';
    } else if (bgType === 'chroma') {
      bgLayer.style.background = settings.bgChromaColor || '#00FF00';
    } else if ((bgType === 'image' || bgType === 'video') && bgRecord && bgRecord.dataUrl) {
      if (bgRecord.mediaType === 'video') {
        bgVideo.classList.remove('hidden');
        if (bgVideo.getAttribute('data-src') !== bgRecord.dataUrl) {
          bgVideo.src = bgRecord.dataUrl;
          bgVideo.setAttribute('data-src', bgRecord.dataUrl);
          bgVideo.play().catch(() => {});
        }
        bgVideo.style.objectFit = settings.bgFit || 'cover';
        bgVideo.style.filter = settings.bgBlurPx > 0 ? `blur(${settings.bgBlurPx * scaleFactor}px)` : 'none';
      } else {
        bgImage.classList.remove('hidden');
        if (bgImage.getAttribute('data-src') !== bgRecord.dataUrl) {
          bgImage.src = bgRecord.dataUrl;
          bgImage.setAttribute('data-src', bgRecord.dataUrl);
        }
        bgImage.style.objectFit = settings.bgFit || 'cover';
        bgImage.style.filter = settings.bgBlurPx > 0 ? `blur(${settings.bgBlurPx * scaleFactor}px)` : 'none';
      }
    }
  }

  // Przyciemnienie nałożone na tło (nie przyciemniamy w trybie Chroma Key / Green Screen ani gdy wyświetlany jest slajd)
  if (isBrowserSlideActive || bgType === 'chroma') {
    bgOverlay.style.background = 'transparent';
  } else {
    const dim = Number(settings.bgDimOpacity ?? 0.35);
    bgOverlay.style.background = `rgba(0, 0, 0, ${dim})`;
  }

  // 2. Marginesy bezpieczne (Safe Area), pozycjonowanie oraz tryb osobnych przestrzeni (split vs overlay)
  const layoutMode = isBrowserSlideActive ? (presState.subtitleLayoutMode || 'overlay') : 'overlay';
  const subPos = isBrowserSlideActive ? (presState.subtitlePosition || 'bottom') : 'bottom';
  const areaHeightPct = isBrowserSlideActive
    ? Math.max(10, Math.min(45, Number(presState.subtitleAreaHeightPct ?? 22)))
    : 22;
  const areaWidthPct = isBrowserSlideActive
    ? Math.max(50, Math.min(100, Number(presState.subtitleAreaWidthPct ?? 90)))
    : 100;
  const subsHidden = Boolean(liveState.blackout || (isBrowserSlideActive && presState.hideSubtitles));
  const isSplitActive = isBrowserSlideActive && layoutMode === 'split' && !subsHidden;

  if (isSplitActive) {
    const splitPos = subPos === 'top' ? 'top' : 'bottom';
    bgLayer.style.top = splitPos === 'top' ? `${areaHeightPct}%` : '0';
    bgLayer.style.bottom = splitPos === 'bottom' ? `${areaHeightPct}%` : '0';
    bgLayer.style.height = `${100 - areaHeightPct}%`;

    safeArea.style.paddingTop = '0';
    safeArea.style.paddingBottom = '0';
    safeArea.style.paddingLeft = '0';
    safeArea.style.paddingRight = '0';
    safeArea.style.justifyContent = splitPos === 'top' ? 'flex-start' : 'flex-end';
    safeArea.style.alignItems = 'center';
  } else if (isBrowserSlideActive) {
    bgLayer.style.top = '0';
    bgLayer.style.bottom = '0';
    bgLayer.style.height = '100%';

    safeArea.style.paddingTop = subPos === 'top' ? '2.5%' : '4%';
    safeArea.style.paddingBottom = subPos === 'bottom' ? '2.5%' : '4%';
    safeArea.style.paddingLeft = '3%';
    safeArea.style.paddingRight = '3%';
    safeArea.style.justifyContent = subPos === 'top' ? 'flex-start' : (subPos === 'center' ? 'center' : 'flex-end');
    safeArea.style.alignItems = 'center';
  } else {
    bgLayer.style.top = '0';
    bgLayer.style.bottom = '0';
    bgLayer.style.height = '100%';

    safeArea.style.paddingTop = `${settings.marginTopPct ?? 8}%`;
    safeArea.style.paddingBottom = `${settings.marginBottomPct ?? 8}%`;
    safeArea.style.paddingLeft = `${settings.marginLeftPct ?? 7}%`;
    safeArea.style.paddingRight = `${settings.marginRightPct ?? 7}%`;
    safeArea.style.alignItems = 'stretch';

    if (settings.displayMode === 'lower-third') {
      safeArea.style.justifyContent = 'flex-end';
    } else {
      safeArea.style.justifyContent = 'center';
    }
  }

  // 3. Obsługa trybu Blackout lub ukrycia napisów nad prezentacją
  if (subsHidden) {
    customBanner.classList.add('hidden');
    subtitlesContainer.classList.add('hidden');
    return;
  }

  // 4. Obsługa własnej planszy / komunikatu przerwy (Custom Banner)
  const textShadowCSS = buildTextShadowCSS(
    settings.textShadowPreset,
    Math.max(0, Math.round((settings.textStrokePx ?? 2) * scaleFactor))
  );
  const slideFontScale = isBrowserSlideActive ? Number(presState.subtitleFontScale ?? 0.85) : 1;
  const scaledFontSize = Math.max(11, Math.round((settings.fontSizePx || 64) * scaleFactor * slideFontScale));

  if (liveState.customBanner && liveState.customBanner.active && (liveState.customBanner.title || liveState.customBanner.subtitle)) {
    subtitlesContainer.classList.add('hidden');
    customBanner.classList.remove('hidden');
    customBanner.style.fontFamily = settings.fontFamily;
    customBanner.style.textAlign = settings.textAlign || 'center';

    bannerTitle.textContent = liveState.customBanner.title || '';
    bannerTitle.style.fontSize = `${Math.round(scaledFontSize * 1.15)}px`;
    bannerTitle.style.fontWeight = settings.fontWeight || '800';
    bannerTitle.style.color = settings.textColor || '#FFFFFF';
    bannerTitle.style.textShadow = textShadowCSS;
    bannerTitle.style.textTransform = settings.uppercaseText ? 'uppercase' : 'none';

    bannerSubtitle.textContent = liveState.customBanner.subtitle || '';
    bannerSubtitle.style.fontSize = `${Math.round(scaledFontSize * 0.62)}px`;
    bannerSubtitle.style.color = settings.draftTextColor || '#BAE6FD';
    bannerSubtitle.style.textShadow = textShadowCSS;
    return;
  }

  customBanner.classList.add('hidden');
  subtitlesContainer.classList.remove('hidden');

  // 5. Styl kontenera napisów (boks pod tekstem, wyrównanie)
  subtitlesContainer.style.fontFamily = settings.fontFamily;
  subtitlesContainer.style.textAlign = settings.textAlign || 'center';
  subtitlesContainer.style.alignItems = settings.textAlign === 'left' ? 'flex-start' : 'center';

  if (isBrowserSlideActive) {
    const pad = Math.max(8, Math.round(18 * scaleFactor));
    const radius = Math.max(6, Math.round(14 * scaleFactor));
    const op = Number(presState.subtitleOpacity ?? 0.78);
    subtitlesContainer.style.width = `${areaWidthPct}%`;
    subtitlesContainer.style.height = isSplitActive ? `${areaHeightPct}%` : 'auto';
    subtitlesContainer.style.minHeight = `${areaHeightPct}%`;
    subtitlesContainer.style.overflow = isSplitActive ? 'hidden' : '';
    subtitlesContainer.style.padding = `${pad}px ${Math.round(pad * 1.5)}px`;
    subtitlesContainer.style.borderRadius = (isSplitActive && areaWidthPct >= 100) ? '0px' : `${radius}px`;

    if (isSplitActive) {
      // Spójny z gradientem tła, ale wyraźnie odcinający się pasek na napisy (głębia + subtelna linia oddzielająca)
      const topAlpha = Math.min(0.9, Math.max(0.55, op * 0.85));
      const botAlpha = Math.min(0.96, Math.max(0.72, op));
      subtitlesContainer.style.background = `linear-gradient(180deg, rgba(15, 23, 42, ${topAlpha}) 0%, rgba(4, 8, 20, ${botAlpha}) 100%)`;
      subtitlesContainer.style.backdropFilter = 'blur(10px)';
      subtitlesContainer.style.border = areaWidthPct < 100 ? '1px solid rgba(148, 163, 184, 0.24)' : 'none';
      if (areaWidthPct >= 100) {
        subtitlesContainer.style.borderTop = subPos === 'bottom' ? '1px solid rgba(129, 140, 248, 0.35)' : 'none';
        subtitlesContainer.style.borderBottom = subPos === 'top' ? '1px solid rgba(129, 140, 248, 0.35)' : 'none';
      }
      subtitlesContainer.style.boxShadow = subPos === 'bottom'
        ? '0 -10px 28px rgba(0, 0, 0, 0.45)'
        : '0 10px 28px rgba(0, 0, 0, 0.45)';
    } else {
      subtitlesContainer.style.background = `rgba(6, 11, 25, ${op})`;
      subtitlesContainer.style.backdropFilter = 'blur(8px)';
      subtitlesContainer.style.border = '1px solid rgba(255,255,255,0.16)';
      subtitlesContainer.style.boxShadow = 'none';
    }
  } else if (settings.textBoxEnabled) {
    subtitlesContainer.style.width = '100%';
    subtitlesContainer.style.height = '';
    subtitlesContainer.style.minHeight = '';
    subtitlesContainer.style.overflow = '';
    const pad = Math.round((settings.textBoxPaddingPx ?? 28) * scaleFactor);
    const radius = Math.round((settings.textBoxRadiusPx ?? 18) * scaleFactor);
    const blur = Math.round((settings.textBoxBlurPx ?? 10) * scaleFactor);
    subtitlesContainer.style.background = hexToRgba(settings.textBoxColor || '#000000', settings.textBoxOpacity ?? 0.65);
    subtitlesContainer.style.padding = `${pad}px ${Math.round(pad * 1.25)}px`;
    subtitlesContainer.style.borderRadius = `${radius}px`;
    subtitlesContainer.style.backdropFilter = blur > 0 ? `blur(${blur}px)` : 'none';
    subtitlesContainer.style.border = '1px solid rgba(255,255,255,0.12)';
  } else {
    subtitlesContainer.style.width = '100%';
    subtitlesContainer.style.height = '';
    subtitlesContainer.style.minHeight = '';
    subtitlesContainer.style.overflow = '';
    subtitlesContainer.style.background = 'transparent';
    subtitlesContainer.style.padding = '0';
    subtitlesContainer.style.borderRadius = '0';
    subtitlesContainer.style.backdropFilter = 'none';
    subtitlesContainer.style.border = 'none';
  }

  // 6. Ukryj globalny pojedynczy znaczek mówcy — teraz każda wypowiedź ma własną kolorową etykietę mówcy
  if (speakerBadge) {
    speakerBadge.classList.add('hidden');
  }

  // 7. Zbuduj listę linii do wyświetlenia na ekranie — wyświetlaj WYŁĄCZNIE gotowe, sfinalizowane tłumaczenia (bez draftów)
  const items = Array.isArray(liveState.items) ? liveState.items : [];
  const draftId = liveState.liveDraft?.id || 'live-draft';
  const hasDisplayableDraft = false;

  let visibleEntries = [];

  if (isBrowserSlideActive || settings.displayMode === 'single-center' || settings.displayMode === 'lower-third') {
    if (hasDisplayableDraft) {
      visibleEntries = [{
        id: draftId,
        en: liveState.liveDraft.en,
        pl: liveState.liveDraft.pl,
        speaker: liveState.liveDraft.speaker || liveState.activeSpeaker || '',
        isDraft: true,
        isPrimary: true
      }];
    } else if (items.length > 0) {
      const last = items[items.length - 1];
      visibleEntries = [{
        ...last,
        isDraft: false,
        isPrimary: true
      }];
    }
  } else {
    // Tryb Teleprompter / Live Transcript: zawsze stała liczba maxCount pozycji bez skoków
    const maxCount = Math.max(1, Number(settings.maxVisibleItems) || 3);
    const historyCount = hasDisplayableDraft ? Math.max(0, maxCount - 1) : maxCount;
    const recentItems = items.slice(-historyCount);

    visibleEntries = recentItems.map((item, idx) => ({
      ...item,
      isDraft: false,
      isPrimary: !hasDisplayableDraft && idx === recentItems.length - 1
    }));

    if (hasDisplayableDraft) {
      visibleEntries.push({
        id: draftId,
        en: liveState.liveDraft.en || '',
        pl: liveState.liveDraft.pl || '',
        speaker: liveState.liveDraft.speaker || liveState.activeSpeaker || '',
        isDraft: true,
        isPrimary: true
      });
    }
  }

  // Odfiltruj puste wpisy
  visibleEntries = visibleEntries.filter(
    (e) => (e.en && e.en.trim()) || (settings.showPolishOriginal && e.pl && e.pl.trim())
  );

  // 8. Sprawdź sygnaturę renderowania — jeśli tekst na ekranie, mówcy i styl liter nie uległy zmianie,
  //    nie dotykaj DOM w ogóle (100% eliminacji migania przy zdarzeniach pośrednich)
  const maxSlots = (isBrowserSlideActive || settings.displayMode === 'single-center' || settings.displayMode === 'lower-third')
    ? 1
    : Math.max(1, Number(settings.maxVisibleItems) || 3);

  const speakerColors = liveState.speakerColors || {};
  const showSpeakerBadge = settings.showSpeakerBadge !== false;

  const renderSig = JSON.stringify({
    maxSlots,
    displayMode: settings.displayMode,
    scaledFontSize,
    fontWeight: settings.fontWeight,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    textColor: settings.textColor,
    draftTextColor: settings.draftTextColor,
    plTextColor: settings.plTextColor,
    textShadowCSS,
    uppercaseText: settings.uppercaseText,
    historyScale: settings.historyScale,
    historyOpacity: settings.historyOpacity,
    showPolishOriginal: settings.showPolishOriginal,
    showSpeakerBadge,
    speakerColors,
    entries: visibleEntries.map((e) => ({
      en: (e.en || '').trim(),
      pl: settings.showPolishOriginal ? (e.pl || '').trim() : '',
      speaker: showSpeakerBadge ? (e.speaker || '').trim() : '',
      isDraft: Boolean(e.isDraft),
      isPrimary: Boolean(e.isPrimary)
    }))
  });

  if (linesWrapper._lastRenderSig === renderSig) {
    return;
  }
  linesWrapper._lastRenderSig = renderSig;

  const lineHeightVal = Number(settings.lineHeight) || 1.24;
  const historyScaleVal = Number(settings.historyScale) || 0.82;
  const historyOpacityVal = Number(settings.historyOpacity) || 0.48;
  const gapPx = Math.max(12, Math.round(scaledFontSize * 0.38));
  linesWrapper.style.gap = `${gapPx}px`;

  // 9. Stałe sloty DOM o zarezerwowanej wysokości (brak przesuwania w górę/dół, gdy zdanie przechodzi do 2. lub 3. linii)
  while (linesWrapper.children.length > maxSlots) {
    linesWrapper.lastElementChild.remove();
  }
  while (linesWrapper.children.length < maxSlots) {
    const slotEl = document.createElement('div');
    slotEl.className = 'stage-line-item';
    const spkEl = document.createElement('div');
    spkEl.className = 'stage-line-speaker hidden';
    const enEl = document.createElement('div');
    enEl.className = 'stage-line-en';
    const plEl = document.createElement('div');
    plEl.className = 'stage-line-pl hidden';
    slotEl.appendChild(spkEl);
    slotEl.appendChild(enEl);
    slotEl.appendChild(plEl);
    linesWrapper.appendChild(slotEl);
  }

  // Wyrównaj wpisy do dolnych slotów, aby starsze zdania miały stałe miejsce
  const paddedEntries = [];
  const emptyCount = Math.max(0, maxSlots - visibleEntries.length);
  for (let i = 0; i < emptyCount; i++) {
    paddedEntries.push(null);
  }
  for (let i = 0; i < visibleEntries.length && paddedEntries.length < maxSlots; i++) {
    paddedEntries.push(visibleEntries[i]);
  }

  for (let slotIdx = 0; slotIdx < maxSlots; slotIdx++) {
    const slotEl = linesWrapper.children[slotIdx];
    const entry = paddedEntries[slotIdx];
    const isBottomSlot = slotIdx === maxSlots - 1;
    const isPrimary = entry ? Boolean(entry.isPrimary) : isBottomSlot;
    const entryScale = isPrimary ? 1 : historyScaleVal;
    const fontSizeVal = Math.round(scaledFontSize * entryScale);

    // Stała zarezerwowana wysokość każdego slotu w trybie Teleprompter zapobiega skakaniu układu w pionie
    const extraSpeakerLines = showSpeakerBadge ? 0.45 : 0;
    if (settings.displayMode === 'teleprompter') {
      const reservedLines = (isBottomSlot ? 2.8 : 2.1) + extraSpeakerLines;
      slotEl.style.minHeight = `${Math.round(fontSizeVal * lineHeightVal * reservedLines)}px`;
    } else if (settings.displayMode === 'single-center') {
      slotEl.style.minHeight = `${Math.round(fontSizeVal * lineHeightVal * (2.6 + extraSpeakerLines))}px`;
    } else {
      slotEl.style.minHeight = '0px';
    }

    let spkEl = slotEl.querySelector('.stage-line-speaker');
    if (!spkEl) {
      spkEl = document.createElement('div');
      spkEl.className = 'stage-line-speaker hidden';
      slotEl.insertBefore(spkEl, slotEl.firstChild);
    }
    const enEl = slotEl.querySelector('.stage-line-en');
    const plEl = slotEl.querySelector('.stage-line-pl');

    if (!entry) {
      slotEl.style.opacity = '0';
      spkEl.classList.add('hidden');
      spkEl.textContent = '';
      enEl.textContent = '';
      plEl.textContent = '';
      plEl.classList.add('hidden');
      continue;
    }

    const targetOpacity = entry.isPrimary ? 1 : historyOpacityVal;
    slotEl.style.opacity = String(targetOpacity);

    const spkName = (entry.speaker || '').trim();
    if (showSpeakerBadge && spkName) {
      spkEl.classList.remove('hidden');
      if (spkEl.textContent !== spkName) {
        spkEl.textContent = spkName;
      }
      const badgeColor = speakerColors[spkName] || settings.speakerBadgeColor || '#F59E0B';
      spkEl.style.backgroundColor = hexToRgba(badgeColor, 0.92);
      spkEl.style.fontSize = `${Math.max(9, Math.round(fontSizeVal * 0.34))}px`;
      spkEl.style.padding = `${Math.max(2, Math.round(4 * scaleFactor))}px ${Math.max(7, Math.round(13 * scaleFactor))}px`;
      spkEl.style.borderRadius = `${Math.max(4, Math.round(6 * scaleFactor))}px`;
      spkEl.style.marginBottom = `${Math.max(3, Math.round(6 * scaleFactor))}px`;
    } else {
      spkEl.classList.add('hidden');
      spkEl.textContent = '';
    }

    enEl.style.fontSize = `${fontSizeVal}px`;
    enEl.style.fontWeight = settings.fontWeight || '800';
    enEl.style.lineHeight = String(lineHeightVal);
    enEl.style.letterSpacing = `${(settings.letterSpacing || 0) * scaleFactor}px`;
    enEl.style.color = entry.isDraft
      ? (settings.draftTextColor || '#BAE6FD')
      : (settings.textColor || '#FFFFFF');
    enEl.style.textShadow = textShadowCSS;
    enEl.style.textTransform = settings.uppercaseText ? 'uppercase' : 'none';

    const nextEn = (entry.en || '').trim();
    if (enEl.textContent !== nextEn) {
      enEl.textContent = nextEn;
    }

    if (settings.showPolishOriginal && entry.pl) {
      plEl.classList.remove('hidden');
      const nextPl = entry.pl.trim();
      if (plEl.textContent !== nextPl) {
        plEl.textContent = nextPl;
      }
      plEl.style.fontSize = `${Math.max(10, Math.round(fontSizeVal * 0.46))}px`;
      plEl.style.color = settings.plTextColor || '#94A3B8';
      plEl.style.textShadow = textShadowCSS;
      plEl.style.marginTop = `${Math.max(3, Math.round(6 * scaleFactor))}px`;
    } else {
      plEl.classList.add('hidden');
    }
  }
}

/**
 * Inicjalizacja pełnoekranowego okna prezentacji (tylko gdy ten skrypt działa w screen.html)
 */
if (document.getElementById('presentationBody')) {
  const sync = new SyncManager('screen');
  let currentBgRecord = null;
  let currentPresState = null;
  let lastPresVersion = -1;

  const dom = {
    bgLayer: document.getElementById('stageBgLayer'),
    bgImage: document.getElementById('stageBgImage'),
    bgVideo: document.getElementById('stageBgVideo'),
    slideImg: document.getElementById('stageSlideImg'),
    slideVideo: document.getElementById('stageSlideVideo'),
    slideCanvas: document.getElementById('stageSlideCanvas'),
    bgOverlay: document.getElementById('stageBgOverlay'),
    safeArea: document.getElementById('stageSafeArea'),
    customBanner: document.getElementById('stageCustomBanner'),
    bannerTitle: document.getElementById('bannerTitle'),
    bannerSubtitle: document.getElementById('bannerSubtitle'),
    subtitlesContainer: document.getElementById('stageSubtitlesContainer'),
    speakerBadge: document.getElementById('stageSpeakerBadge'),
    linesWrapper: document.getElementById('stageLinesWrapper')
  };

  const handleStageAnimEnded = async (cueSeq) => {
    try {
      const res = await fetch('/api/presentation/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'animEnded', cueSeq })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.state && data.state.version !== lastPresVersion) {
          lastPresVersion = data.state.version;
          currentPresState = data.state;
          render();
        }
      }
    } catch (_) {}
  };

  const render = () => {
    renderStageDOM(dom, sync.settings, sync.liveState, currentBgRecord, 1, currentPresState, {
      onAnimEnded: handleStageAnimEnded
    });
  };

  async function pollPresentationState() {
    try {
      const res = await fetch('/api/presentation', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.version !== lastPresVersion) {
          lastPresVersion = data.version;
          currentPresState = data;
          render();
        }
      }
    } catch {
      // ignore transient network errors
    } finally {
      setTimeout(pollPresentationState, 250);
    }
  }
  pollPresentationState();

  async function refreshBackground() {
    currentBgRecord = await loadBackgroundMedia();
    render();
  }

  sync.onChange(() => render());
  sync.onBackgroundChange(async (bgMeta) => {
    if (bgMeta && bgMeta.dataUrl) {
      currentBgRecord = bgMeta;
      render();
    } else {
      await refreshBackground();
    }
  });

  refreshBackground().then(() => {
    sync.requestFullSync();
  });

  // Obsługa pełnego ekranu i automatycznego ukrywania kursora oraz przycisku HUD
  const hud = document.getElementById('stageFloatingHud');
  const btnFullscreen = document.getElementById('btnToggleFullscreen');
  let idleTimer = null;

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  btnFullscreen?.addEventListener('click', toggleFullscreen);
  document.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    }
  });

  function wakeHud() {
    document.body.classList.remove('cursor-hidden');
    hud?.classList.remove('hud-hidden');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      hud?.classList.add('hud-hidden');
      document.body.classList.add('cursor-hidden');
    }, 2400);
  }

  window.addEventListener('mousemove', wakeHud);
  window.addEventListener('mousedown', wakeHud);
  wakeHud();
}
