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

/**
 * Funkcja renderująca stan i wygląd ekranu prezentacji na dowolnym zestawie elementów DOM
 * (używana zarówno w pełnoekranowym screen.html, jak i w miniaturowym podglądzie w index.html).
 */
export function renderStageDOM(dom, settings, liveState, bgRecord, scaleFactor = 1) {
  const {
    bgLayer,
    bgImage,
    bgVideo,
    bgOverlay,
    safeArea,
    customBanner,
    bannerTitle,
    bannerSubtitle,
    subtitlesContainer,
    speakerBadge,
    linesWrapper
  } = dom;

  // 1. Konfiguracja Tła
  const bgType = settings.bgType || 'gradient';
  bgLayer.style.background = '#090D16';
  bgImage.classList.add('hidden');
  bgVideo.classList.add('hidden');

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

  // Przyciemnienie nałożone na tło (nie przyciemniamy w trybie Chroma Key / Green Screen)
  if (bgType === 'chroma') {
    bgOverlay.style.background = 'transparent';
  } else {
    const dim = Number(settings.bgDimOpacity ?? 0.35);
    bgOverlay.style.background = `rgba(0, 0, 0, ${dim})`;
  }

  // 2. Marginesy bezpieczne (Safe Area) oraz pozycjonowanie w pionie
  safeArea.style.paddingTop = `${settings.marginTopPct ?? 8}%`;
  safeArea.style.paddingBottom = `${settings.marginBottomPct ?? 8}%`;
  safeArea.style.paddingLeft = `${settings.marginLeftPct ?? 7}%`;
  safeArea.style.paddingRight = `${settings.marginRightPct ?? 7}%`;

  if (settings.displayMode === 'lower-third') {
    safeArea.style.justifyContent = 'flex-end';
  } else {
    safeArea.style.justifyContent = 'center';
  }

  // 3. Obsługa trybu Blackout (wygaszenie samego tekstu na ekranie)
  if (liveState.blackout) {
    customBanner.classList.add('hidden');
    subtitlesContainer.classList.add('hidden');
    return;
  }

  // 4. Obsługa własnej planszy / komunikatu przerwy (Custom Banner)
  const textShadowCSS = buildTextShadowCSS(
    settings.textShadowPreset,
    Math.max(0, Math.round((settings.textStrokePx ?? 2) * scaleFactor))
  );
  const scaledFontSize = Math.max(11, Math.round((settings.fontSizePx || 64) * scaleFactor));

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

  if (settings.textBoxEnabled) {
    const pad = Math.round((settings.textBoxPaddingPx ?? 28) * scaleFactor);
    const radius = Math.round((settings.textBoxRadiusPx ?? 18) * scaleFactor);
    const blur = Math.round((settings.textBoxBlurPx ?? 10) * scaleFactor);
    subtitlesContainer.style.background = hexToRgba(settings.textBoxColor || '#000000', settings.textBoxOpacity ?? 0.65);
    subtitlesContainer.style.padding = `${pad}px ${Math.round(pad * 1.25)}px`;
    subtitlesContainer.style.borderRadius = `${radius}px`;
    subtitlesContainer.style.backdropFilter = blur > 0 ? `blur(${blur}px)` : 'none';
    subtitlesContainer.style.border = '1px solid rgba(255,255,255,0.12)';
  } else {
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

  if (settings.displayMode === 'single-center' || settings.displayMode === 'lower-third') {
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
  const maxSlots = (settings.displayMode === 'single-center' || settings.displayMode === 'lower-third')
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

  const dom = {
    bgLayer: document.getElementById('stageBgLayer'),
    bgImage: document.getElementById('stageBgImage'),
    bgVideo: document.getElementById('stageBgVideo'),
    bgOverlay: document.getElementById('stageBgOverlay'),
    safeArea: document.getElementById('stageSafeArea'),
    customBanner: document.getElementById('stageCustomBanner'),
    bannerTitle: document.getElementById('bannerTitle'),
    bannerSubtitle: document.getElementById('bannerSubtitle'),
    subtitlesContainer: document.getElementById('stageSubtitlesContainer'),
    speakerBadge: document.getElementById('stageSpeakerBadge'),
    linesWrapper: document.getElementById('stageLinesWrapper')
  };

  const render = () => {
    renderStageDOM(dom, sync.settings, sync.liveState, currentBgRecord, 1);
  };

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
