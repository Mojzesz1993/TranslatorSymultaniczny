/**
 * operator.js
 * Logika Panelu Operatora (index.html).
 * Łączy interfejs sterowania z silnikiem rozpoznawania/tłumaczenia mowy (translator-engine.js)
 * oraz synchronizacją Ekranu Prezentacji (sync.js + screen.js).
 */

import {
  SyncManager,
  saveBackgroundMedia,
  loadBackgroundMedia,
  DEFAULT_SETTINGS,
  SUPPORTED_LANGUAGES,
  getLanguageInfo
} from './sync.js';
import { renderStageDOM } from './screen.js';
import { DebateTranslatorEngine } from './translator-engine.js';
import { VoiceIdentificationManager } from './voice-id.js';

const sync = new SyncManager('operator');
let currentBgRecord = null;
let currentPresentationState = null;
let lastPresVersion = -1;
let presenterPortCached = 8766;
let presentationWindowRef = null;
let presenterControlWindowRef = null;

// Elementy DOM Mini-Monitora (Podgląd 16:9)
const previewWrapper = document.getElementById('previewMonitorWrapper');
const previewDom = {
  bgLayer: document.getElementById('prevBgLayer'),
  bgImage: document.getElementById('prevBgImage'),
  bgVideo: document.getElementById('prevBgVideo'),
  slideImg: document.getElementById('prevSlideImg'),
  slideVideo: document.getElementById('prevSlideVideo'),
  slideCanvas: document.getElementById('prevSlideCanvas'),
  bgOverlay: document.getElementById('prevBgOverlay'),
  safeArea: document.getElementById('prevSafeArea'),
  customBanner: document.getElementById('prevCustomBanner'),
  bannerTitle: document.getElementById('prevBannerTitle'),
  bannerSubtitle: document.getElementById('prevBannerSubtitle'),
  subtitlesContainer: document.getElementById('prevSubtitlesContainer'),
  speakerBadge: document.getElementById('prevSpeakerBadge'),
  linesWrapper: document.getElementById('prevLinesWrapper')
};

// Inicjalizacja modułu rozpoznawania głosów (Voiceprint ID)
const voiceId = new VoiceIdentificationManager({
  onSpeakerRecognized: (profile) => {
    if (!profile || !profile.name) return;
    const prevActive = sync.liveState.activeSpeaker || '';
    if (prevActive === profile.name) return;

    // Zaktualizuj aktywnego mówcę w silniku (wstecznie dla krótkiego początku zdania lub zamknij długą kwestię poprzednika)
    engine.handleSpeakerChange(profile.name, prevActive);

    const statePatch = {
      activeSpeaker: profile.name
    };

    // Jeśli na ekranie jest już aktywny szkic (liveDraft) z pierwszych słów nowego mówcy, od razu zmień mu plakietkę
    if (sync.liveState.liveDraft && sync.liveState.liveDraft.pl) {
      const draftWords = sync.liveState.liveDraft.pl.trim().split(/\s+/).filter(Boolean);
      if (draftWords.length <= 6) {
        statePatch.liveDraft = {
          ...sync.liveState.liveDraft,
          speaker: profile.name,
          updatedAt: Date.now()
        };
      }
    } else if (Array.isArray(sync.liveState.items) && sync.liveState.items.length > 0) {
      // Jeśli mówca powiedział krótkie wtrącenie (1-5 słów), które sfinalizowało się ułamek sekundy przed wynikiem ONNX
      const items = sync.liveState.items;
      const lastItem = items[items.length - 1];
      const ageMs = Date.now() - (lastItem.createdAt || 0);
      const wordCount = (lastItem.pl || '').trim().split(/\s+/).filter(Boolean).length;
      if (ageMs < 1800 && wordCount >= 1 && wordCount <= 5 && lastItem.speaker !== profile.name) {
        statePatch.items = items.map((it, idx) =>
          idx === items.length - 1 ? { ...it, speaker: profile.name } : it
        );
      }
    }

    sync.updateLiveState(statePatch);
    renderSpeakerChips();
    renderVoiceProfilesList();
  },
  onProfilesUpdated: () => {
    syncVoiceProfilesToLiveState();
    renderSpeakerChips();
    renderVoiceProfilesList();
  },
  onLiveConfidenceUpdate: ({ bestProfile, bestConfidence, currentPitchHz, scoresMap }) => {
    const detEl = document.getElementById('voiceLiveDetectedLabel');
    const pitchEl = document.getElementById('voiceLivePitchLabel');
    const confEl = document.getElementById('voiceLiveConfidenceLabel');

    if (pitchEl) {
      pitchEl.textContent = currentPitchHz ? `${currentPitchHz} Hz` : '— Hz';
    }
    if (confEl) {
      confEl.textContent = bestConfidence > 0 ? `${bestConfidence}%` : '—%';
    }
    if (detEl) {
      if (bestProfile && bestConfidence >= Math.round(voiceId.sensitivityThreshold * 100)) {
        detEl.textContent = `${bestProfile.name} (${bestConfidence}%)`;
        detEl.style.color = bestProfile.color || '#38bdf8';
      } else if (bestProfile) {
        detEl.textContent = `Najbliżej: ${bestProfile.name} (${bestConfidence}% — poniżej progu)`;
        detEl.style.color = '#94a3b8';
      } else {
        detEl.textContent = 'Brak przyuczonych wzorców głosu';
        detEl.style.color = '#94a3b8';
      }
    }
    if (scoresMap) {
      document.querySelectorAll('[data-speaker-score-id]').forEach((el) => {
        const spkId = el.getAttribute('data-speaker-score-id');
        const pct = scoresMap[spkId];
        if (typeof pct === 'number') {
          el.textContent = `${pct}%`;
          el.style.color = pct >= Math.round(voiceId.sensitivityThreshold * 100) ? '#10b981' : '#94a3b8';
        }
      });
    }
  }
});

function syncVoiceProfilesToLiveState() {
  const speakerColors = {};
  const speakersList = [];
  voiceId.profiles.forEach((p) => {
    if (p.name) {
      speakersList.push(p.name);
      speakerColors[p.name] = p.color || '#F59E0B';
    }
  });
  sync.saveApiConfig({ speakersList });
  sync.updateLiveState({ speakerColors });
  const inpSpeakers = document.getElementById('inpSpeakersList');
  if (inpSpeakers && document.activeElement !== inpSpeakers) {
    inpSpeakers.value = speakersList.join(', ');
  }
}

// Inicjalizacja silnika tłumaczenia
let onDraftUpdateLastSync = 0;
const engine = new DebateTranslatorEngine({
  getApiConfig: () => {
    const slideParts = [];
    if (currentPresentationState && currentPresentationState.active) {
      if (currentPresentationState.currentSlideText) {
        slideParts.push(currentPresentationState.currentSlideText);
      }
      if (currentPresentationState.currentSpeakerNotes) {
        slideParts.push(`Notatki: ${currentPresentationState.currentSpeakerNotes}`);
      }
    }
    return {
      ...sync.apiConfig,
      currentSlideContext: slideParts.join('\n').slice(0, 1800)
    };
  },
  getRecentContext: () => sync.liveState.items.slice(-6),
  onAudioSourceReady: (audioCtx, sourceNode) => {
    voiceId.attachToAudioContext(audioCtx, sourceNode);
  },
  onAudioSourceStopped: () => {
    voiceId.detachAudio();
  },
  onDraftUpdate: ({ id, pl, en, speaker, plOnly, isStreaming }) => {
    document.getElementById('liveDraftPl').textContent = pl ? `🎙 ${pl}...` : '—';
    if (en) {
      document.getElementById('liveDraftEn').textContent = en;
    }

    const resolvedSpeaker = speaker || sync.liveState.activeSpeaker || '';
    if (!engine.activeSegmentSpeaker && resolvedSpeaker) {
      engine.activeSegmentSpeaker = resolvedSpeaker;
    }

    // Gdy napływa strumieniowane tłumaczenie z Gemini (lub Live Draft EN), pokazuj je od razu na ekranie prezentacji (z lekkim throttlingiem 100 ms)
    if (en && !plOnly) {
      const now = Date.now();
      const lastSync = onDraftUpdateLastSync || 0;
      if (now - lastSync >= 100) {
        onDraftUpdateLastSync = now;
        sync.updateLiveState({
          liveDraft: {
            id: id || 'live-draft',
            pl: pl || '',
            en,
            speaker: resolvedSpeaker,
            isStreaming: !!isStreaming,
            updatedAt: now
          }
        });
      }
    }
  },
  onFinalSegment: ({ id, pl, en, speaker }) => {
    const segId = id || ('seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const currentItems = Array.isArray(sync.liveState.items) ? sync.liveState.items : [];
    const existingIndex = currentItems.findIndex((item) => item.id === segId);

    let nextItems;
    if (existingIndex !== -1) {
      nextItems = currentItems.map((item, idx) =>
        idx === existingIndex
          ? {
              ...item,
              pl: pl || item.pl,
              en: en || item.en,
              speaker: item.speaker || speaker || sync.liveState.activeSpeaker || '',
              isFinal: true
            }
          : item
      );
    } else {
      const newItem = {
        id: segId,
        createdAt: Date.now(),
        timestamp: new Date().toLocaleTimeString('pl-PL', { hour12: false }),
        speaker: speaker || sync.liveState.activeSpeaker || '',
        pl: pl || '',
        en: en || '',
        isFinal: true
      };
      nextItems = [...currentItems, newItem];
    }

    // Pokaż w panelu operatora ostatnie sczytane zdanie PL oraz jego gotowe tłumaczenie EN
    onDraftUpdateLastSync = 0;
    document.getElementById('liveDraftPl').textContent = pl ? `✓ ${pl}` : '—';
    document.getElementById('liveDraftEn').textContent = en ? `✓ ${en}` : '—';

    sync.updateLiveState({
      liveDraft: { id: null, pl: '', en: '', speaker: '', updatedAt: Date.now() },
      items: nextItems
    });
  },
  onStatusChange: ({ state, label }) => {
    const pill = document.getElementById('statusPill');
    const text = document.getElementById('statusText');
    const btnStartStop = document.getElementById('btnStartStop');
    const btnMute = document.getElementById('btnMute');

    pill.classList.remove('is-running', 'is-muted', 'is-error');
    if (state === 'running') pill.classList.add('is-running');
    else if (state === 'muted') pill.classList.add('is-muted');
    else if (state === 'error') pill.classList.add('is-error');

    text.textContent = label || 'GOTOWY';

    if (engine.isRunning) {
      btnStartStop.textContent = '■ ZATRZYMAJ TŁUMACZENIE';
      btnStartStop.className = 'btn btn-stop';
    } else {
      btnStartStop.textContent = '▶ START TŁUMACZENIA';
      btnStartStop.className = 'btn btn-start';
    }

    if (engine.isMuted) {
      btnMute.classList.add('active');
      btnMute.textContent = '🔊 WZNÓW NASŁUCH (ODCISZ)';
    } else {
      btnMute.classList.remove('active');
      btnMute.textContent = '⏸ PAUZA / MUTE';
    }

    sync.updateLiveState({
      isListening: engine.isRunning,
      isMuted: engine.isMuted
    });
  },
  onAudioLevel: (level) => {
    const fill = document.getElementById('vuMeterFill');
    if (fill) {
      fill.style.width = `${level}%`;
    }
  },
  onError: (msg) => {
    showErrorAlert(msg);
  },
  onModelAutoSwitched: (newModel, discoveredList = []) => {
    sync.saveApiConfig({ geminiModel: newModel });
    const sel = document.getElementById('selGeminiModel');
    if (sel) {
      if (discoveredList.length > 0) {
        populateModelDropdown(sel, discoveredList, newModel);
      } else {
        ensureOptionExists(sel, newModel);
        sel.value = newModel;
      }
    }
  }
});

function showErrorAlert(message) {
  const box = document.getElementById('errorAlertBox');
  const text = document.getElementById('errorAlertText');
  text.textContent = message;
  box.classList.remove('hidden');
}

document.getElementById('btnDismissError')?.addEventListener('click', () => {
  document.getElementById('errorAlertBox').classList.add('hidden');
});

/**
 * Renderowanie Mini-Podglądu 16:9 w Panelu Operatora (ze skalowaniem względem 1920px szerokości)
 */
function renderMiniPreview() {
  const rect = previewWrapper.getBoundingClientRect();
  const scaleFactor = rect.width > 0 ? rect.width / 1920 : 0.3;
  renderStageDOM(previewDom, sync.settings, sync.liveState, currentBgRecord, scaleFactor, currentPresentationState);
  updateModeBadges();
}

function updateModeBadges() {
  const modeBadge = document.getElementById('activeModeBadge');
  const modeMap = {
    hybrid: 'Tryb: Hybryda (Web Speech PL + Gemini Flash)',
    'gemini-audio': 'Tryb: Bezpośrednie Audio ➔ Gemini',
    demo: 'Tryb: Symulacja Demo'
  };
  modeBadge.textContent = modeMap[sync.apiConfig.engineMode] || '';

  const btnBlackout = document.getElementById('btnToggleBlackout');
  if (sync.liveState.blackout) {
    btnBlackout.className = 'btn btn-sm btn-stop';
    btnBlackout.textContent = '🌑 BLACKOUT AKTYWNY (Kliknij aby pokazać tekst)';
  } else {
    btnBlackout.className = 'btn btn-sm btn-outline';
    btnBlackout.textContent = '🌑 Wygaszenie tekstu (Blackout)';
  }

  const btnBanner = document.getElementById('btnToggleBanner');
  if (sync.liveState.customBanner?.active) {
    btnBanner.className = 'btn btn-stop';
    btnBanner.textContent = '✕ Ukryj planszę i wróć do napisów tłumaczenia';
  } else {
    btnBanner.className = 'btn btn-primary';
    btnBanner.textContent = '🪧 Wyświetl planszę na ekranie prezentacji';
  }

  const btnQuickAutoVoice = document.getElementById('btnQuickToggleAutoVoice');
  if (btnQuickAutoVoice) {
    if (voiceId.autoRecognizeEnabled) {
      btnQuickAutoVoice.className = 'btn btn-sm btn-primary';
      btnQuickAutoVoice.textContent = '🤖 Auto-Głos: WŁ.';
    } else {
      btnQuickAutoVoice.className = 'btn btn-sm btn-outline';
      btnQuickAutoVoice.textContent = '🤖 Auto-Głos: WYŁ.';
    }
  }

  const btnQuickBadges = document.getElementById('btnQuickToggleSpeakerBadges');
  if (btnQuickBadges) {
    const showBadges = sync.settings.showSpeakerBadge !== false;
    if (showBadges) {
      btnQuickBadges.className = 'btn btn-sm btn-primary';
      btnQuickBadges.textContent = '🏷 Podpisy na ekranie: WŁ.';
    } else {
      btnQuickBadges.className = 'btn btn-sm btn-outline';
      btnQuickBadges.textContent = '🏷 Podpisy na ekranie: WYŁ.';
    }
  }
}

/**
 * Renderowanie listy historii wypowiedzi z edycją tekstu EN na żywo
 */
function renderTranscriptHistory() {
  const container = document.getElementById('transcriptList');
  const items = Array.isArray(sync.liveState.items) ? sync.liveState.items : [];
  const maxVisible = Number(sync.settings.maxVisibleItems) || 3;
  const visibleIds = new Set(items.slice(-maxVisible).map((i) => i.id));

  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding: 20px; color: #64748b; font-size: 13px;">Brak wypowiedzi na ekranie. Naciśnij <b>START TŁUMACZENIA</b> lub wyślij tekst ręcznie.</div>`;
    return;
  }

  // Wyświetlamy od najnowszej na górze, aby operator miał ostatnie zdania pod ręką
  [...items].reverse().forEach((item) => {
    const row = document.createElement('div');
    const isOnScreen = visibleIds.has(item.id);
    row.className = `transcript-item ${isOnScreen ? 'is-on-screen' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'transcript-meta';
    meta.innerHTML = `
      <span>
        <b>${item.timestamp || ''}</b>
        ${item.speaker ? ` • <span style="color:#f59e0b; font-weight:700;">${escapeHtml(item.speaker)}</span>` : ''}
        ${isOnScreen ? ` • <span style="color:#38bdf8; font-weight:700;">[WIDOCZNE NA EKRANIE]</span>` : ''}
      </span>
    `;

    const actionsDiv = document.createElement('div');
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '6px';

    const btnRetranslate = document.createElement('button');
    btnRetranslate.className = 'btn btn-sm btn-outline';
    btnRetranslate.style.padding = '2px 7px';
    btnRetranslate.style.fontSize = '11px';
    btnRetranslate.textContent = '🔄 Przetłumacz ponownie';
    btnRetranslate.title = 'Ponownie przetłumacz to polskie zdanie przez Gemini AI';
    btnRetranslate.addEventListener('click', async () => {
      if (!item.pl) return;
      btnRetranslate.textContent = '⏳...';
      try {
        const freshEn = await engine.translatePolishTextToEnglish(item.pl, false);
        if (freshEn) {
          updateTranscriptItemEn(item.id, freshEn);
        }
      } catch (err) {
        showErrorAlert(err.message);
      } finally {
        btnRetranslate.textContent = '🔄 Przetłumacz ponownie';
      }
    });

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-sm btn-outline';
    btnDelete.style.padding = '2px 7px';
    btnDelete.style.fontSize = '11px';
    btnDelete.textContent = '🗑 Usuń';
    btnDelete.addEventListener('click', () => {
      const filtered = sync.liveState.items.filter((x) => x.id !== item.id);
      sync.updateLiveState({ items: filtered });
    });

    actionsDiv.appendChild(btnRetranslate);
    actionsDiv.appendChild(btnDelete);
    meta.appendChild(actionsDiv);
    row.appendChild(meta);

    if (item.pl) {
      const plDiv = document.createElement('div');
      plDiv.className = 'transcript-pl';
      plDiv.textContent = `🇵🇱 ${item.pl}`;
      row.appendChild(plDiv);
    }

    const enInput = document.createElement('input');
    enInput.type = 'text';
    enInput.className = 'transcript-en-input';
    enInput.value = item.en || '';
    enInput.title = 'Edytuj tekst angielski — zmiana natychmiast pojawi się na ekranie prezentacji';
    enInput.addEventListener('input', (e) => {
      updateTranscriptItemEn(item.id, e.target.value, false);
    });

    row.appendChild(enInput);
    container.appendChild(row);
  });
}

function updateTranscriptItemEn(id, newEn, rerenderList = true) {
  const updated = (sync.liveState.items || []).map((item) =>
    item.id === id ? { ...item, en: newEn } : item
  );
  sync.liveState.items = updated;
  try {
    localStorage.setItem('debate_translator_live_state_v1', JSON.stringify(sync.liveState));
  } catch (_) {}
  sync.broadcast({
    type: 'SYNC_UPDATE',
    settings: sync.settings,
    liveState: sync.liveState
  });
  renderMiniPreview();
  if (rerenderList) {
    renderTranscriptHistory();
  }
}

/**
 * Renderowanie przycisków szybkiego wyboru mówcy
 */
function renderSpeakerChips() {
  const container = document.getElementById('speakerChipsContainer');
  if (!container) return;
  const active = sync.liveState.activeSpeaker || '';

  container.innerHTML = '';

  const noneChip = document.createElement('button');
  noneChip.className = `speaker-chip ${active === '' ? 'active' : ''}`;
  noneChip.textContent = 'Brak podpisu';
  noneChip.addEventListener('click', () => {
    const nextDraft = sync.liveState.liveDraft?.id
      ? { ...sync.liveState.liveDraft, speaker: '', updatedAt: Date.now() }
      : sync.liveState.liveDraft;
    sync.updateLiveState({ activeSpeaker: '', liveDraft: nextDraft });
    renderSpeakerChips();
    renderVoiceProfilesList();
  });
  container.appendChild(noneChip);

  voiceId.profiles.forEach((prof) => {
    const sp = prof.name;
    const isAct = active === sp;
    const chip = document.createElement('button');
    chip.className = `speaker-chip ${isAct ? 'active' : ''}`;
    if (isAct) {
      chip.style.backgroundColor = prof.color || '#F59E0B';
      chip.style.borderColor = prof.color || '#F59E0B';
      chip.style.color = '#090d16';
    } else {
      chip.style.borderLeft = `4px solid ${prof.color || '#F59E0B'}`;
    }
    const enrolledIcon = prof.voiceprint ? '🎙 ' : '';
    chip.textContent = `${enrolledIcon}${sp}`;
    chip.title = prof.voiceprint
      ? `${sp} — głos przyuczony (${prof.sampleCount || 1} próbki). Kliknij aby wybrać mówcę.`
      : `${sp} — kliknij aby ustawić jako aktualnego mówcę`;
    chip.addEventListener('click', () => {
      if (active !== sp) {
        engine.handleSpeakerChange(sp, active);
      }
      sync.updateLiveState({ activeSpeaker: sp });
      renderSpeakerChips();
      renderVoiceProfilesList();
    });
    container.appendChild(chip);
  });
}

/**
 * Powiązanie kontrolek formularzy z ustawieniami
 */
function bindAppearanceControls() {
  const s = sync.settings;

  const selBgType = document.getElementById('selBgType');
  const inpBgColor = document.getElementById('inpBgColor');
  const selBgFit = document.getElementById('selBgFit');
  const rngBgDim = document.getElementById('rngBgDim');
  const valBgDim = document.getElementById('valBgDim');
  const rngBgBlur = document.getElementById('rngBgBlur');
  const valBgBlur = document.getElementById('valBgBlur');

  const selDisplayMode = document.getElementById('selDisplayMode');
  const rngMaxItems = document.getElementById('rngMaxItems');
  const valMaxItems = document.getElementById('valMaxItems');
  const rngFontSize = document.getElementById('rngFontSize');
  const valFontSize = document.getElementById('valFontSize');
  const selFontFamily = document.getElementById('selFontFamily');
  const selFontWeight = document.getElementById('selFontWeight');
  const inpTextColor = document.getElementById('inpTextColor');
  const inpDraftColor = document.getElementById('inpDraftColor');
  const selTextShadow = document.getElementById('selTextShadow');
  const selTextAlign = document.getElementById('selTextAlign');

  const chkTextBoxEnabled = document.getElementById('chkTextBoxEnabled');
  const chkShowPolishOriginal = document.getElementById('chkShowPolishOriginal');
  const chkUppercaseText = document.getElementById('chkUppercaseText');
  const chkShowLiveDraft = document.getElementById('chkShowLiveDraft');

  const rngMarginTop = document.getElementById('rngMarginTop');
  const valMarginTop = document.getElementById('valMarginTop');
  const rngMarginBottom = document.getElementById('rngMarginBottom');
  const valMarginBottom = document.getElementById('valMarginBottom');
  const rngMarginLeft = document.getElementById('rngMarginLeft');
  const valMarginLeft = document.getElementById('valMarginLeft');
  const rngMarginRight = document.getElementById('rngMarginRight');
  const valMarginRight = document.getElementById('valMarginRight');

  function syncInputsFromSettings(curr) {
    selBgType.value = curr.bgType || 'gradient';
    inpBgColor.value = curr.bgColor || '#090D16';
    selBgFit.value = curr.bgFit || 'cover';
    const dimPct = Math.round((curr.bgDimOpacity ?? 0.35) * 100);
    rngBgDim.value = String(dimPct);
    valBgDim.textContent = `${dimPct}%`;
    rngBgBlur.value = String(curr.bgBlurPx ?? 0);
    valBgBlur.textContent = `${curr.bgBlurPx ?? 0} px`;

    selDisplayMode.value = curr.displayMode || 'teleprompter';
    rngMaxItems.value = String(curr.maxVisibleItems || 3);
    valMaxItems.textContent = `${curr.maxVisibleItems || 3} zdania`;

    rngFontSize.value = String(curr.fontSizePx || 64);
    valFontSize.textContent = `${curr.fontSizePx || 64} px`;
    selFontFamily.value = curr.fontFamily || DEFAULT_SETTINGS.fontFamily;
    selFontWeight.value = String(curr.fontWeight || '800');
    inpTextColor.value = curr.textColor || '#FFFFFF';
    inpDraftColor.value = curr.draftTextColor || '#BAE6FD';
    selTextShadow.value = curr.textShadowPreset || 'strong-outline';
    selTextAlign.value = curr.textAlign || 'center';

    chkTextBoxEnabled.checked = Boolean(curr.textBoxEnabled);
    chkShowPolishOriginal.checked = Boolean(curr.showPolishOriginal);
    chkUppercaseText.checked = Boolean(curr.uppercaseText);
    chkShowLiveDraft.checked = curr.showLiveDraft !== false;

    rngMarginTop.value = String(curr.marginTopPct ?? 8);
    valMarginTop.textContent = `${curr.marginTopPct ?? 8}%`;
    rngMarginBottom.value = String(curr.marginBottomPct ?? 8);
    valMarginBottom.textContent = `${curr.marginBottomPct ?? 8}%`;
    rngMarginLeft.value = String(curr.marginLeftPct ?? 7);
    valMarginLeft.textContent = `${curr.marginLeftPct ?? 7}%`;
    rngMarginRight.value = String(curr.marginRightPct ?? 7);
    valMarginRight.textContent = `${curr.marginRightPct ?? 7}%`;
  }

  syncInputsFromSettings(s);

  selBgType.addEventListener('change', () => sync.updateSettings({ bgType: selBgType.value }));
  inpBgColor.addEventListener('input', () => sync.updateSettings({ bgType: 'color', bgColor: inpBgColor.value }));
  selBgFit.addEventListener('change', () => sync.updateSettings({ bgFit: selBgFit.value }));

  rngBgDim.addEventListener('input', () => {
    const pct = Number(rngBgDim.value);
    valBgDim.textContent = `${pct}%`;
    sync.updateSettings({ bgDimOpacity: pct / 100 });
  });

  rngBgBlur.addEventListener('input', () => {
    const px = Number(rngBgBlur.value);
    valBgBlur.textContent = `${px} px`;
    sync.updateSettings({ bgBlurPx: px });
  });

  // Presety tła
  document.querySelectorAll('[data-bg-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-bg-preset');
      if (preset === 'navy') {
        sync.updateSettings({
          bgType: 'gradient',
          bgGradient: 'linear-gradient(135deg, #060B19 0%, #0F172A 50%, #1E1B4B 100%)'
        });
      } else if (preset === 'cinema-black') {
        sync.updateSettings({ bgType: 'color', bgColor: '#000000', bgDimOpacity: 0 });
      } else if (preset === 'emerald') {
        sync.updateSettings({
          bgType: 'gradient',
          bgGradient: 'linear-gradient(135deg, #022C22 0%, #064E3B 55%, #0F172A 100%)'
        });
      } else if (preset === 'burgundy') {
        sync.updateSettings({
          bgType: 'gradient',
          bgGradient: 'linear-gradient(135deg, #2A0815 0%, #4C0519 50%, #0F172A 100%)'
        });
      } else if (preset === 'greenscreen') {
        sync.updateSettings({
          bgType: 'chroma',
          bgChromaColor: '#00FF00'
        });
      }
      syncInputsFromSettings(sync.settings);
    });
  });

  // Wgrywanie własnego pliku obrazu lub wideo z dysku
  const fileInput = document.getElementById('fileBgUpload');
  document.getElementById('btnUploadBg').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const mediaType = isVideo ? 'video' : 'image';

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      currentBgRecord = { dataUrl, mediaType, fileName: file.name };
      await saveBackgroundMedia(dataUrl, mediaType, file.name);
      sync.updateSettings({ bgType: mediaType });
      sync.notifyBackgroundChanged(currentBgRecord);
      selBgType.value = mediaType;
      document.getElementById('bgFileInfo').textContent = `✓ Wgrano tło z dysku: ${file.name}`;
      renderMiniPreview();
    };
    reader.readAsDataURL(file);
  });

  // Typografia
  selDisplayMode.addEventListener('change', () => sync.updateSettings({ displayMode: selDisplayMode.value }));
  rngMaxItems.addEventListener('input', () => {
    const count = Number(rngMaxItems.value);
    valMaxItems.textContent = `${count} zdania`;
    sync.updateSettings({ maxVisibleItems: count });
  });
  rngFontSize.addEventListener('input', () => {
    const px = Number(rngFontSize.value);
    valFontSize.textContent = `${px} px`;
    sync.updateSettings({ fontSizePx: px });
  });
  selFontFamily.addEventListener('change', () => sync.updateSettings({ fontFamily: selFontFamily.value }));
  selFontWeight.addEventListener('change', () => sync.updateSettings({ fontWeight: selFontWeight.value }));
  inpTextColor.addEventListener('input', () => sync.updateSettings({ textColor: inpTextColor.value }));
  inpDraftColor.addEventListener('input', () => sync.updateSettings({ draftTextColor: inpDraftColor.value }));
  selTextShadow.addEventListener('change', () => sync.updateSettings({ textShadowPreset: selTextShadow.value }));
  selTextAlign.addEventListener('change', () => sync.updateSettings({ textAlign: selTextAlign.value }));

  chkTextBoxEnabled.addEventListener('change', () => sync.updateSettings({ textBoxEnabled: chkTextBoxEnabled.checked }));
  chkShowPolishOriginal.addEventListener('change', () => sync.updateSettings({ showPolishOriginal: chkShowPolishOriginal.checked }));
  chkUppercaseText.addEventListener('change', () => sync.updateSettings({ uppercaseText: chkUppercaseText.checked }));
  chkShowLiveDraft.addEventListener('change', () => sync.updateSettings({ showLiveDraft: chkShowLiveDraft.checked }));

  // Marginesy Safe Area
  rngMarginTop.addEventListener('input', () => {
    valMarginTop.textContent = `${rngMarginTop.value}%`;
    sync.updateSettings({ marginTopPct: Number(rngMarginTop.value) });
  });
  rngMarginBottom.addEventListener('input', () => {
    valMarginBottom.textContent = `${rngMarginBottom.value}%`;
    sync.updateSettings({ marginBottomPct: Number(rngMarginBottom.value) });
  });
  rngMarginLeft.addEventListener('input', () => {
    valMarginLeft.textContent = `${rngMarginLeft.value}%`;
    sync.updateSettings({ marginLeftPct: Number(rngMarginLeft.value) });
  });
  rngMarginRight.addEventListener('input', () => {
    valMarginRight.textContent = `${rngMarginRight.value}%`;
    sync.updateSettings({ marginRightPct: Number(rngMarginRight.value) });
  });

  document.getElementById('btnResetAppearance').addEventListener('click', () => {
    sync.resetSettings();
    syncInputsFromSettings(sync.settings);
  });
}

/**
 * Konfiguracja silnika AI, klucza Gemini API, wyboru mikrofonu oraz słowniczka
 */
function bindEngineAndContextControls() {
  const cfg = sync.apiConfig;

  const inpGeminiKey = document.getElementById('inpGeminiKey');
  const selSourceLang = document.getElementById('selSourceLang');
  const selTargetLang = document.getElementById('selTargetLang');
  const btnSwapLanguages = document.getElementById('btnSwapLanguages');
  const langAutoHint = document.getElementById('langAutoHint');
  const selEngineMode = document.getElementById('selEngineMode');
  const selGeminiModel = document.getElementById('selGeminiModel');
  const selAudioDevice = document.getElementById('selAudioDevice');
  const rngDraftInterval = document.getElementById('rngDraftInterval');
  const valDraftInterval = document.getElementById('valDraftInterval');

  const txtDebateTopic = document.getElementById('txtDebateTopic');
  const txtGlossary = document.getElementById('txtGlossary');
  const inpSpeakersList = document.getElementById('inpSpeakersList');

  function populateLanguageSelects() {
    if (!selSourceLang || !selTargetLang) return;
    selSourceLang.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = '✨ Auto-wykrywanie mowy (Tryb Direct Audio Gemini)';
    selSourceLang.appendChild(autoOpt);

    selTargetLang.innerHTML = '';
    SUPPORTED_LANGUAGES.forEach((lang) => {
      const optSrc = document.createElement('option');
      optSrc.value = lang.code;
      optSrc.textContent = `${lang.namePl} (${lang.code.toUpperCase()})`;
      selSourceLang.appendChild(optSrc);

      const optTgt = document.createElement('option');
      optTgt.value = lang.code;
      optTgt.textContent = `${lang.namePl} (${lang.code.toUpperCase()})`;
      selTargetLang.appendChild(optTgt);
    });

    selSourceLang.value = cfg.sourceLang || 'pl';
    selTargetLang.value = cfg.targetLang || 'en';
  }

  function updateLanguageLabels() {
    const sCode = sync.apiConfig.sourceLang || 'pl';
    const tCode = sync.apiConfig.targetLang || 'en';
    const sInfo = getLanguageInfo(sCode);
    const tInfo = getLanguageInfo(tCode);
    const sUpper = sCode === 'auto' ? 'AUTO' : sCode.toUpperCase();
    const tUpper = tCode.toUpperCase();

    const badge = document.getElementById('opLangPairBadge');
    const sub = document.getElementById('opBrandSub');
    const srcLbl = document.getElementById('lblSourceDraftTitle');
    const tgtLbl = document.getElementById('lblTargetDraftTitle');

    if (badge) badge.textContent = `${sUpper}▸${tUpper}`;
    if (sub) sub.textContent = `Tłumaczenie symultaniczne audio ${sInfo.namePl} ➔ napisy ${tInfo.namePl} na żywo`;
    if (srcLbl) srcLbl.textContent = `🎙 Sczytywana mowa z mikrofonu (${sUpper}):`;
    if (tgtLbl) tgtLbl.textContent = `💬 Ostatnie gotowe tłumaczenie (${tUpper}):`;
    if (langAutoHint) langAutoHint.classList.toggle('hidden', sCode !== 'auto');
  }

  populateLanguageSelects();
  updateLanguageLabels();

  function handleLanguagePairChange() {
    const src = selSourceLang.value;
    const tgt = selTargetLang.value;
    const updates = { sourceLang: src, targetLang: tgt };
    if (src === 'auto' && sync.apiConfig.engineMode === 'hybrid') {
      updates.engineMode = 'gemini-audio';
      selEngineMode.value = 'gemini-audio';
    }
    sync.saveApiConfig(updates);
    updateLanguageLabels();
    updateModeBadges();
    if (engine.isRunning) {
      engine.stop();
      setTimeout(() => engine.start(), 220);
    }
  }

  selSourceLang?.addEventListener('change', handleLanguagePairChange);
  selTargetLang?.addEventListener('change', handleLanguagePairChange);
  btnSwapLanguages?.addEventListener('click', () => {
    const curSrc = selSourceLang.value;
    const curTgt = selTargetLang.value;
    if (curSrc === 'auto') return;
    selSourceLang.value = curTgt;
    selTargetLang.value = curSrc;
    handleLanguagePairChange();
  });

  inpGeminiKey.value = cfg.geminiApiKey || '';
  selEngineMode.value = cfg.engineMode || 'hybrid';
  ensureOptionExists(selGeminiModel, cfg.geminiModel || 'gemini-flash-latest');
  selGeminiModel.value = cfg.geminiModel || 'gemini-flash-latest';
  rngDraftInterval.value = String(cfg.draftIntervalMs || 1100);
  valDraftInterval.textContent = `${((cfg.draftIntervalMs || 1100) / 1000).toFixed(1)} s`;

  txtDebateTopic.value = cfg.debateTopic || '';
  txtGlossary.value = cfg.glossary || '';
  inpSpeakersList.value = (cfg.speakersList || []).join(', ');

  inpGeminiKey.addEventListener('input', () => {
    sync.saveApiConfig({ geminiApiKey: inpGeminiKey.value.trim() });
  });

  document.getElementById('btnToggleKeyVisibility').addEventListener('click', (e) => {
    if (inpGeminiKey.type === 'password') {
      inpGeminiKey.type = 'text';
      e.target.textContent = '🙈 Ukryj';
    } else {
      inpGeminiKey.type = 'password';
      e.target.textContent = '👁 Pokaż';
    }
  });

  async function detectAndPopulateModels(showFeedback = true) {
    const resEl = document.getElementById('geminiTestResult');
    const apiKey = inpGeminiKey.value.trim();
    sync.saveApiConfig({ geminiApiKey: apiKey });
    if (!apiKey) {
      if (showFeedback) {
        resEl.style.color = '#fca5a5';
        resEl.textContent = '✕ Najpierw wklej klucz Google Gemini API.';
      }
      return [];
    }
    if (showFeedback) {
      resEl.style.color = '#38bdf8';
      resEl.textContent = '⏳ Pobieranie listy dostępnych modeli dla Twojego klucza...';
    }
    const models = await engine.discoverAvailableModels(apiKey);
    if (models.length > 0) {
      const current = sync.apiConfig.geminiModel;
      const bestModel = models.includes(current) ? current : models[0];
      populateModelDropdown(selGeminiModel, models, bestModel);
      sync.saveApiConfig({ geminiModel: bestModel });
      if (showFeedback) {
        resEl.style.color = '#6ee7b7';
        resEl.textContent = `✓ Wykryto ${models.length} modeli Gemini. Wybrano optymalny model: ${bestModel}`;
      }
    } else if (showFeedback) {
      resEl.style.color = '#fcd34d';
      resEl.textContent = '⚠ Nie udało się pobrać listy modeli — sprawdź poprawność klucza API.';
    }
    return models;
  }

  document.getElementById('btnDetectModels')?.addEventListener('click', () => {
    detectAndPopulateModels(true);
  });

  document.getElementById('btnTestGeminiKey').addEventListener('click', async () => {
    const resEl = document.getElementById('geminiTestResult');
    sync.saveApiConfig({ geminiApiKey: inpGeminiKey.value.trim() });
    if (!sync.apiConfig.geminiApiKey) {
      resEl.style.color = '#fca5a5';
      resEl.textContent = '✕ Najpierw wklej klucz Google Gemini API.';
      return;
    }
    resEl.style.color = '#38bdf8';
    resEl.textContent = '⏳ Testowanie połączenia i dobieranie najlepszego modelu Gemini...';
    try {
      await detectAndPopulateModels(false);
      const sample = await engine.translatePolishTextToEnglish('Rozpoczynamy debatę.', false, '', false);
      resEl.style.color = '#6ee7b7';
      resEl.textContent = `✓ Połączenie działa (model: ${sync.apiConfig.geminiModel})! Przykładowe tłumaczenie: "${sample}"`;
    } catch (err) {
      resEl.style.color = '#fca5a5';
      resEl.textContent = `✕ Błąd klucza lub połączenia: ${err.message}`;
    }
  });

  selEngineMode.addEventListener('change', () => {
    const updates = { engineMode: selEngineMode.value };
    if (selEngineMode.value === 'hybrid' && sync.apiConfig.sourceLang === 'auto') {
      updates.sourceLang = 'pl';
      if (selSourceLang) selSourceLang.value = 'pl';
    }
    sync.saveApiConfig(updates);
    updateLanguageLabels();
    updateModeBadges();
    if (engine.isRunning) {
      engine.stop();
      setTimeout(() => engine.start(), 200);
    }
  });

  selGeminiModel.addEventListener('change', () => {
    sync.saveApiConfig({ geminiModel: selGeminiModel.value });
  });

  rngDraftInterval.addEventListener('input', () => {
    const ms = Number(rngDraftInterval.value);
    valDraftInterval.textContent = `${(ms / 1000).toFixed(1)} s`;
    sync.saveApiConfig({ draftIntervalMs: ms });
  });

  // Wykrywanie urządzeń wejściowych Audio (mikser USB, mikrofon, Line-In)
  async function populateAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      selAudioDevice.innerHTML = '<option value="default">Domyślne urządzenie wejściowe systemu</option>';
      audioInputs.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Wejście mikrofonowe / liniowe #${idx + 1}`;
        selAudioDevice.appendChild(opt);
      });
      if (sync.apiConfig.audioDeviceId) {
        selAudioDevice.value = sync.apiConfig.audioDeviceId;
      }
    } catch (_) {}
  }

  populateAudioDevices();
  document.getElementById('btnRefreshAudioDevices').addEventListener('click', async () => {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
      await populateAudioDevices();
    } catch (err) {
      showErrorAlert('Aby zobaczyć pełne nazwy mikrofonów, zezwól przeglądarce na dostęp do dźwięku.');
    }
  });

  selAudioDevice.addEventListener('change', () => {
    sync.saveApiConfig({ audioDeviceId: selAudioDevice.value });
    if (engine.isRunning) {
      engine.stop();
      setTimeout(() => engine.start(), 200);
    }
  });

  // Kontekst i słowniczek
  txtDebateTopic.addEventListener('input', () => {
    sync.saveApiConfig({ debateTopic: txtDebateTopic.value });
  });

  txtGlossary.addEventListener('input', () => {
    sync.saveApiConfig({ glossary: txtGlossary.value });
  });

  document.getElementById('btnSaveSpeakers').addEventListener('click', () => {
    const names = inpSpeakersList.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Zachowaj istniejące profile głosowe dla mówców o tej samej nazwie
    const nextProfiles = names.map((name, idx) => {
      const existing = voiceId.getSpeakerByName(name);
      if (existing) {
        return { ...existing, name };
      }
      return {
        id: 'spk-' + Date.now() + '-' + idx,
        name,
        color: ['#F59E0B', '#38BDF8', '#10B981', '#EC4899', '#A855F7', '#F97316'][idx % 6],
        voiceprint: null,
        sampleCount: 0
      };
    });
    voiceId.profiles = nextProfiles;
    voiceId.saveProfiles();
  });
}

/**
 * Obsługa modułu Automatycznego Rozpoznawania Głosów (Voiceprint ID)
 */
let pendingFileSpeakerId = null;

function setVoiceStatusMessage(msg, color = '#38bdf8') {
  const el = document.getElementById('voiceEnrollmentStatusMsg');
  if (el) {
    el.style.color = color;
    el.textContent = msg;
  }
}

async function runTimedMicEnrollmentWithFallbackStream(speakerId, durationMs = 4000, onDone = null) {
  // Jeśli silnik tłumaczenia już działa i ma otwarty mikrofon, korzystamy z niego bezpośrednio
  if (engine.isRunning && voiceId.analysisTimer) {
    voiceId.startTimedEnrollment(speakerId, durationMs, (res) => {
      onDone?.(res);
    });
    return;
  }

  // Jeśli tłumaczenie jest zatrzymane (np. próba mikrofonowa przed debatą), otwórz tymczasowy strumień audio na 4s
  let tempStream = null;
  let tempCtx = null;
  try {
    const deviceId = sync.apiConfig.audioDeviceId;
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {})
      },
      video: false
    };
    tempStream = await navigator.mediaDevices.getUserMedia(constraints);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    tempCtx = new AudioCtx();
    const source = tempCtx.createMediaStreamSource(tempStream);
    voiceId.attachToAudioContext(tempCtx, source);

    voiceId.startTimedEnrollment(speakerId, durationMs, (res) => {
      voiceId.detachAudio();
      tempStream?.getTracks().forEach((t) => t.stop());
      tempCtx?.close().catch(() => {});
      onDone?.(res);
    });
  } catch (err) {
    voiceId.detachAudio();
    tempStream?.getTracks().forEach((t) => t.stop());
    tempCtx?.close().catch(() => {});
    onDone?.({
      ok: false,
      message: 'Brak dostępu do mikrofonu. Zezwól przeglądarce na użycie mikrofonu.'
    });
  }
}

function renderVoiceProfilesList() {
  const container = document.getElementById('voiceProfilesContainer');
  if (!container) return;

  const activeSpeaker = sync.liveState.activeSpeaker || '';
  container.innerHTML = '';

  voiceId.profiles.forEach((prof) => {
    const row = document.createElement('div');
    const isActive = activeSpeaker === prof.name;
    row.className = `voice-profile-row ${isActive ? 'is-active-speaker' : ''}`;

    const mainDiv = document.createElement('div');
    mainDiv.className = 'voice-profile-main';

    // Wybór koloru etykiety mówcy
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'voice-color-picker';
    colorInput.value = prof.color || '#F59E0B';
    colorInput.title = 'Zmień kolor podpisu tego mówcy na ekranie prezentacji';
    colorInput.addEventListener('input', () => {
      voiceId.updateSpeaker(prof.id, { color: colorInput.value });
    });

    // Edycja imienia i nazwiska / roli mówcy
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'input voice-name-input';
    nameInput.value = prof.name;
    nameInput.title = 'Imię i nazwisko lub rola wyświetlana na ekranie prezentacji';
    nameInput.addEventListener('change', () => {
      const clean = nameInput.value.trim();
      if (!clean) return;
      const wasActive = sync.liveState.activeSpeaker === prof.name;
      voiceId.updateSpeaker(prof.id, { name: clean });
      if (wasActive) {
        sync.updateLiveState({ activeSpeaker: clean });
      }
    });

    // Status próbki głosu
    const statusBadge = document.createElement('span');
    const isRecordingThis = voiceId.enrollingSpeakerId === prof.id;
    if (isRecordingThis) {
      statusBadge.className = 'voice-status-badge is-recording';
      statusBadge.textContent = '⏺ Nagrywanie 4s...';
    } else if (prof.voiceprint && Array.isArray(prof.voiceprint.embedding)) {
      statusBadge.className = 'voice-status-badge is-enrolled';
      statusBadge.innerHTML = `✓ AI 512-D (${prof.voiceprint.pitchHz || '—'}Hz • ${prof.sampleCount || 1}x) • <b data-speaker-score-id="${prof.id}" style="color:#94a3b8;">—%</b>`;
    } else {
      statusBadge.className = 'voice-status-badge';
      statusBadge.textContent = 'Brak próbki AI (nagraj 4s lub przypisz na żywo)';
    }

    mainDiv.appendChild(colorInput);
    mainDiv.appendChild(nameInput);
    mainDiv.appendChild(statusBadge);

    // Przyciski akcji dla mówcy
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'voice-profile-actions';

    // 1. Ucz z bieżącego głosu na żywo (ostatnie 4s)
    const btnLiveLearn = document.createElement('button');
    btnLiveLearn.className = 'btn btn-sm btn-primary';
    btnLiveLearn.textContent = '🎯 Przypisz obecny głos';
    btnLiveLearn.title = 'Jednym kliknięciem wyodrębnij wektor neuronowy 512-D z ostatnich sekund mowy i przypisz do tego prelegenta';
    btnLiveLearn.addEventListener('click', () => {
      const res = voiceId.learnFromRecentLiveVoice(prof.id);
      if (res.mode === 'instant') {
        setVoiceStatusMessage(
          `✓ Wyodrębniono wektor neuronowy AI 512-D (WeSpeaker CAM++) dla „${prof.name}” z bufora na żywo!`,
          '#6ee7b7'
        );
      } else {
        setVoiceStatusMessage(`🎙 Zbieranie próbki głosu dla sieci neuronowej AI — „${prof.name}” (mów przez 3.5 sekundy)...`, '#fcd34d');
        renderVoiceProfilesList();
        runTimedMicEnrollmentWithFallbackStream(prof.id, 3500, (doneRes) => {
          if (doneRes?.ok) {
            setVoiceStatusMessage(
              `✓ Przyuczono głos dla „${prof.name}” (ton F0: ${doneRes.profile?.voiceprint?.pitchHz || '—'} Hz)!`,
              '#6ee7b7'
            );
          } else {
            setVoiceStatusMessage(`⚠ ${doneRes?.message || 'Nie wykryto mowy.'}`, '#fca5a5');
          }
          renderVoiceProfilesList();
        });
      }
    });

    // 2. Nagraj próbkę 4s z mikrofonu (działa nawet przed włączeniem tłumaczenia!)
    const btnRecord4s = document.createElement('button');
    btnRecord4s.className = 'btn btn-sm btn-outline';
    btnRecord4s.textContent = '🎙 Nagraj 4s';
    btnRecord4s.title = 'Nagraj 4-sekundową próbkę głosu z mikrofonu dla tego prelegenta';
    btnRecord4s.addEventListener('click', () => {
      setVoiceStatusMessage(`⏺ Nagrywanie 4-sekundowej próbki głosu dla „${prof.name}” — poproś o krótką wypowiedź...`, '#fcd34d');
      voiceId.enrollingSpeakerId = prof.id;
      renderVoiceProfilesList();
      runTimedMicEnrollmentWithFallbackStream(prof.id, 4000, (doneRes) => {
        if (doneRes?.ok) {
          setVoiceStatusMessage(
            `✓ Zapisano 4-sekundową próbkę głosu dla „${prof.name}” (F0: ${doneRes.profile?.voiceprint?.pitchHz || '—'} Hz)!`,
            '#6ee7b7'
          );
        } else {
          setVoiceStatusMessage(`⚠ ${doneRes?.message || 'Za mało mowy podczas nagrywania.'}`, '#fca5a5');
        }
        renderVoiceProfilesList();
      });
    });

    // 3. Wgraj plik audio z głosem mówcy
    const btnUploadVoice = document.createElement('button');
    btnUploadVoice.className = 'btn btn-sm btn-outline';
    btnUploadVoice.textContent = '📁 Z pliku';
    btnUploadVoice.title = 'Wgraj próbkę głosu z pliku audio/wideo na dysku (WAV, MP3, M4A, MP4)';
    btnUploadVoice.addEventListener('click', () => {
      pendingFileSpeakerId = prof.id;
      document.getElementById('fileVoiceSampleUpload')?.click();
    });

    // 4. Wyczyść wzorzec lub usuń mówcę
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-sm btn-outline';
    btnDelete.textContent = '🗑';
    btnDelete.title = prof.voiceprint
      ? 'Kliknij aby wyczyścić próbkę głosu (lub kliknij ponownie aby usunąć mówcę)'
      : 'Usuń tego prelegenta z listy';
    btnDelete.addEventListener('click', () => {
      if (prof.voiceprint) {
        voiceId.clearVoiceprint(prof.id);
        setVoiceStatusMessage(`Wyczyszczono próbkę głosu dla „${prof.name}”.`, '#94a3b8');
      } else {
        voiceId.removeSpeaker(prof.id);
      }
    });

    actionsDiv.appendChild(btnLiveLearn);
    actionsDiv.appendChild(btnRecord4s);
    actionsDiv.appendChild(btnUploadVoice);
    actionsDiv.appendChild(btnDelete);

    row.appendChild(mainDiv);
    row.appendChild(actionsDiv);
    container.appendChild(row);
  });
}

function bindVoiceRecognitionControls() {
  const chkAutoVoiceId = document.getElementById('chkAutoVoiceId');
  const chkShowSpeakerBadge = document.getElementById('chkShowSpeakerBadge');
  const rngVoiceSensitivity = document.getElementById('rngVoiceSensitivity');
  const valVoiceSensitivity = document.getElementById('valVoiceSensitivity');
  const inpNewSpeakerName = document.getElementById('inpNewSpeakerName');
  const btnAddVoiceSpeaker = document.getElementById('btnAddVoiceSpeaker');
  const fileVoiceSampleUpload = document.getElementById('fileVoiceSampleUpload');

  if (chkAutoVoiceId) {
    chkAutoVoiceId.checked = voiceId.autoRecognizeEnabled;
    chkAutoVoiceId.addEventListener('change', () => {
      voiceId.autoRecognizeEnabled = chkAutoVoiceId.checked;
      updateModeBadges();
    });
  }

  if (chkShowSpeakerBadge) {
    chkShowSpeakerBadge.checked = sync.settings.showSpeakerBadge !== false;
    chkShowSpeakerBadge.addEventListener('change', () => {
      sync.updateSettings({ showSpeakerBadge: chkShowSpeakerBadge.checked });
      updateModeBadges();
    });
  }

  if (rngVoiceSensitivity && valVoiceSensitivity) {
    const initPct = Math.round(voiceId.sensitivityThreshold * 100);
    rngVoiceSensitivity.value = String(initPct);
    valVoiceSensitivity.textContent = `${initPct}%`;
    rngVoiceSensitivity.addEventListener('input', () => {
      const pct = Number(rngVoiceSensitivity.value);
      valVoiceSensitivity.textContent = `${pct}%`;
      voiceId.sensitivityThreshold = pct / 100;
    });
  }

  function addSpeakerFromInput() {
    const name = inpNewSpeakerName?.value.trim();
    if (!name) return;
    voiceId.addSpeaker(name);
    inpNewSpeakerName.value = '';
    setVoiceStatusMessage(`✓ Dodano prelegenta „${name}”. Teraz możesz przypisać mu próbkę głosu.`, '#6ee7b7');
  }

  btnAddVoiceSpeaker?.addEventListener('click', addSpeakerFromInput);
  inpNewSpeakerName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSpeakerFromInput();
    }
  });

  fileVoiceSampleUpload?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !pendingFileSpeakerId) return;
    const prof = voiceId.profiles.find((p) => p.id === pendingFileSpeakerId);
    setVoiceStatusMessage(`⏳ Analizowanie barwy głosu z pliku „${file.name}” dla ${prof?.name || ''}...`, '#38bdf8');
    try {
      const updated = await voiceId.enrollFromAudioFile(pendingFileSpeakerId, file);
      setVoiceStatusMessage(
        `✓ Wgrano wzorzec głosu z pliku dla „${updated.name}” (ton podstawowy F0: ${updated.voiceprint?.pitchHz || '—'} Hz)!`,
        '#6ee7b7'
      );
    } catch (err) {
      setVoiceStatusMessage(`✕ Błąd analizy pliku audio: ${err.message}`, '#fca5a5');
    }
  });

  // Szybkie przyciski pod podglądem 16:9
  document.getElementById('btnQuickLearnActiveVoice')?.addEventListener('click', () => {
    const activeName = sync.liveState.activeSpeaker;
    const prof = voiceId.getSpeakerByName(activeName) || voiceId.profiles[0];
    if (!prof) return;
    sync.updateLiveState({ activeSpeaker: prof.name });
    const res = voiceId.learnFromRecentLiveVoice(prof.id);
    if (res.mode === 'instant') {
      setVoiceStatusMessage(`✓ Przypisano obecny głos na żywo do: ${prof.name}`, '#6ee7b7');
    } else {
      runTimedMicEnrollmentWithFallbackStream(prof.id, 3500, () => renderVoiceProfilesList());
    }
    renderSpeakerChips();
    renderVoiceProfilesList();
  });

  document.getElementById('btnQuickToggleAutoVoice')?.addEventListener('click', () => {
    voiceId.autoRecognizeEnabled = !voiceId.autoRecognizeEnabled;
    if (chkAutoVoiceId) chkAutoVoiceId.checked = voiceId.autoRecognizeEnabled;
    updateModeBadges();
  });

  document.getElementById('btnQuickToggleSpeakerBadges')?.addEventListener('click', () => {
    const nextVal = !(sync.settings.showSpeakerBadge !== false);
    sync.updateSettings({ showSpeakerBadge: nextVal });
    if (chkShowSpeakerBadge) chkShowSpeakerBadge.checked = nextVal;
    updateModeBadges();
  });
}

/**
 * Obsługa Planszy Przerwy / Powitania (Custom Banner)
 */
function bindBannerControls() {
  const inpTitle = document.getElementById('inpBannerTitle');
  const inpSubtitle = document.getElementById('inpBannerSubtitle');
  const presetsContainer = document.getElementById('bannerPresetsContainer');
  const editorBox = document.getElementById('bannerPresetEditor');
  const editorHeading = document.getElementById('bannerPresetEditorTitle');
  const inpPresetLabel = document.getElementById('inpPresetLabel');
  const inpPresetTitle = document.getElementById('inpPresetTitle');
  const inpPresetSubtitle = document.getElementById('inpPresetSubtitle');

  let editingPresetId = null;

  inpTitle.value = sync.liveState.customBanner?.title || 'WELCOME TO THE DEBATE';
  inpSubtitle.value = sync.liveState.customBanner?.subtitle || 'Live English Translation — Starting Shortly';

  function updateBannerText() {
    sync.updateLiveState({
      customBanner: {
        ...sync.liveState.customBanner,
        title: inpTitle.value,
        subtitle: inpSubtitle.value
      }
    });
  }

  inpTitle.addEventListener('input', updateBannerText);
  inpSubtitle.addEventListener('input', updateBannerText);

  document.getElementById('btnToggleBanner').addEventListener('click', () => {
    const currActive = Boolean(sync.liveState.customBanner?.active);
    sync.updateLiveState({
      customBanner: {
        active: !currActive,
        title: inpTitle.value,
        subtitle: inpSubtitle.value
      }
    });
  });

  function getPresets() {
    const list = sync.settings.bannerPresets;
    return Array.isArray(list) ? list : [];
  }

  function openPresetEditor(preset = null) {
    if (preset) {
      editingPresetId = preset.id;
      editorHeading.textContent = `Edycja presetu: ${preset.label}`;
      inpPresetLabel.value = preset.label || '';
      inpPresetTitle.value = preset.title || '';
      inpPresetSubtitle.value = preset.subtitle || '';
    } else {
      editingPresetId = null;
      editorHeading.textContent = 'Nowy preset planszy';
      inpPresetLabel.value = inpTitle.value.trim() ? inpTitle.value.trim().slice(0, 28) : '';
      inpPresetTitle.value = inpTitle.value || '';
      inpPresetSubtitle.value = inpSubtitle.value || '';
    }
    editorBox.style.display = 'block';
    inpPresetLabel.focus();
  }

  function closePresetEditor() {
    editingPresetId = null;
    editorBox.style.display = 'none';
  }

  function renderPresets() {
    const presets = getPresets();
    presetsContainer.innerHTML = '';

    presets.forEach((preset) => {
      const group = document.createElement('div');
      group.style.cssText = 'display: inline-flex; align-items: center; gap: 2px;';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-outline btn-sm';
      applyBtn.textContent = preset.label || preset.title || 'Preset';
      applyBtn.title = `${preset.title || ''}${preset.subtitle ? ' — ' + preset.subtitle : ''}`;
      applyBtn.addEventListener('click', () => {
        inpTitle.value = preset.title || '';
        inpSubtitle.value = preset.subtitle || '';
        sync.updateLiveState({
          customBanner: {
            active: true,
            title: inpTitle.value,
            subtitle: inpSubtitle.value
          }
        });
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-sm';
      editBtn.textContent = '✏️';
      editBtn.title = 'Edytuj preset';
      editBtn.style.padding = '4px 7px';
      editBtn.addEventListener('click', () => openPresetEditor(preset));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-outline btn-sm';
      delBtn.textContent = '🗑';
      delBtn.title = 'Usuń preset';
      delBtn.style.padding = '4px 7px';
      delBtn.addEventListener('click', () => {
        const next = getPresets().filter((p) => p.id !== preset.id);
        sync.updateSettings({ bannerPresets: next });
        if (editingPresetId === preset.id) closePresetEditor();
        renderPresets();
      });

      group.appendChild(applyBtn);
      group.appendChild(editBtn);
      group.appendChild(delBtn);
      presetsContainer.appendChild(group);
    });
  }

  document.getElementById('btnAddBannerPreset').addEventListener('click', () => {
    openPresetEditor(null);
  });

  document.getElementById('btnCancelBannerPreset').addEventListener('click', closePresetEditor);

  document.getElementById('btnSaveBannerPreset').addEventListener('click', () => {
    const label = inpPresetLabel.value.trim() || inpPresetTitle.value.trim() || 'Własny preset';
    const title = inpPresetTitle.value.trim();
    const subtitle = inpPresetSubtitle.value.trim();

    const current = getPresets();
    let next;
    if (editingPresetId) {
      next = current.map((p) => (p.id === editingPresetId ? { ...p, label, title, subtitle } : p));
    } else {
      const newPreset = {
        id: 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
        label,
        title,
        subtitle
      };
      next = [...current, newPreset];
    }

    sync.updateSettings({ bannerPresets: next });
    closePresetEditor();
    renderPresets();
  });

  renderPresets();
}

/**
 * Przyciski Główne, Ręczne wysyłanie zdań oraz Eksport zapisu debaty
 */
function bindTransportAndActions() {
  document.getElementById('btnStartStop').addEventListener('click', () => {
    if (engine.isRunning) {
      engine.stop();
    } else {
      engine.start();
    }
  });

  document.getElementById('btnMute').addEventListener('click', () => {
    if (!engine.isRunning) return;
    engine.setMuted(!engine.isMuted);
  });

  // Skrót klawiszowy Ctrl+M do szybkiego wyciszania mikrofonu
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (engine.isRunning) {
        engine.setMuted(!engine.isMuted);
      }
    }
  });

  let cachedMonitors = [];
  fetch('/api/monitors', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (data && Array.isArray(data.monitors)) cachedMonitors = data.monitors;
    })
    .catch(() => {});

  // Otwarcie dedykowanego okna Ekranu Prezentacji (na wybrany monitor / rzutnik)
  document.getElementById('btnOpenScreenWindow').addEventListener('click', async () => {
    try {
      const mRes = await fetch('/api/monitors', { cache: 'no-store' });
      const mData = await mRes.json();
      if (mData && Array.isArray(mData.monitors)) cachedMonitors = mData.monitors;
    } catch {
      // użyj ostatniej znanej listy monitorów
    }

    const monIdx = Number(currentPresentationState?.nativeMonitorIndex ?? 0);
    const mon = cachedMonitors.find((m) => Number(m.index) === monIdx) || cachedMonitors[0];

    if (presentationWindowRef && !presentationWindowRef.closed) {
      if (mon) {
        try {
          presentationWindowRef.moveTo(mon.left, mon.top);
          presentationWindowRef.resizeTo(mon.width, mon.height);
        } catch {
          // ignore
        }
      }
      presentationWindowRef.focus();
      return;
    }

    const features = mon
      ? `left=${mon.left},top=${mon.top},width=${mon.width},height=${mon.height},menubar=no,toolbar=no,location=no,status=no`
      : 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no';

    presentationWindowRef = window.open(
      'screen.html',
      'DebatePresentationScreen',
      features
    );
  });

  // Otwarcie osobnego Panelu Sterowania Prezentacją (port 8766)
  document.getElementById('btnOpenPresenterWindow')?.addEventListener('click', () => {
    if (presenterControlWindowRef && !presenterControlWindowRef.closed) {
      presenterControlWindowRef.focus();
      return;
    }
    const host = window.location.hostname || 'localhost';
    presenterControlWindowRef = window.open(
      `http://${host}:${presenterPortCached}/`,
      'DebatePresenterControl',
      'width=1280,height=840'
    );
  });

  // Pobierz info o porcie panelu slajdów i uruchom synchronizację stanu slajdów dla mini-podglądu i kontekstu Gemini
  fetch('/api/server-info', { cache: 'no-store' })
    .then((r) => r.json())
    .then((info) => {
      if (info && info.presenterPort) presenterPortCached = info.presenterPort;
    })
    .catch(() => {});

  async function pollOperatorPresentation() {
    try {
      const res = await fetch('/api/presentation', { cache: 'no-store' });
      if (res.ok) {
        const st = await res.json();
        if (st && st.version !== lastPresVersion) {
          lastPresVersion = st.version;
          currentPresentationState = st;
          renderMiniPreview();
        }
      }
    } catch {
      // ignore
    } finally {
      setTimeout(pollOperatorPresentation, 350);
    }
  }
  pollOperatorPresentation();

  function clearTranslationHistory() {
    document.getElementById('liveDraftPl').textContent = '—';
    document.getElementById('liveDraftEn').textContent = '—';
    sync.updateLiveState({
      liveDraft: { id: null, pl: '', en: '', speaker: '', updatedAt: Date.now() },
      items: []
    });
  }

  // Wyczyść napisy z ekranu
  document.getElementById('btnClearScreen').addEventListener('click', clearTranslationHistory);

  // Wyczyść historię tłumaczenia (z potwierdzeniem, jeśli zawiera wpisy)
  document.getElementById('btnClearHistory').addEventListener('click', () => {
    const count = (sync.liveState.items || []).length;
    if (count > 0 && !confirm('Czy na pewno wyczyścić całą historię tłumaczenia?')) {
      return;
    }
    clearTranslationHistory();
  });

  // Blackout (wygaszenie samego tekstu)
  document.getElementById('btnToggleBlackout').addEventListener('click', () => {
    sync.updateLiveState({
      blackout: !sync.liveState.blackout
    });
  });

  // Ręczne wysłanie tekstu na ekran
  const manualInput = document.getElementById('manualTextInput');

  function sendManualEnglish(textEn, textPl = '') {
    const clean = textEn.trim();
    if (!clean) return;
    const item = {
      id: 'manual-' + Date.now(),
      timestamp: new Date().toLocaleTimeString('pl-PL', { hour12: false }),
      speaker: sync.liveState.activeSpeaker || '',
      pl: textPl,
      en: clean,
      isFinal: true
    };
    sync.updateLiveState({
      items: [...(sync.liveState.items || []), item]
    });
    manualInput.value = '';
  }

  document.getElementById('btnSendManualEn').addEventListener('click', () => {
    sendManualEnglish(manualInput.value);
  });

  document.getElementById('btnTranslateAndSendManual').addEventListener('click', async () => {
    const rawPl = manualInput.value.trim();
    if (!rawPl) return;
    const btn = document.getElementById('btnTranslateAndSendManual');
    btn.textContent = '⏳ Tłumaczenie...';
    try {
      const translated = await engine.translatePolishTextToEnglish(rawPl, false);
      sendManualEnglish(translated || rawPl, rawPl);
    } catch (err) {
      showErrorAlert(err.message);
    } finally {
      btn.textContent = 'Przetłumacz PL➔EN i wyślij';
    }
  });

  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendManualEnglish(manualInput.value);
    }
  });

  // Przełączanie zakładek
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // Eksport historii debaty
  document.getElementById('btnExportTxt').addEventListener('click', () => exportTranscript('txt'));
  document.getElementById('btnExportMd').addEventListener('click', () => exportTranscript('md'));
  document.getElementById('btnExportSrt').addEventListener('click', () => exportTranscript('srt'));
}

function exportTranscript(format) {
  const items = sync.liveState.items || [];
  if (items.length === 0) {
    showErrorAlert('Brak zapisanych wypowiedzi do eksportu.');
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  let content = '';
  let ext = format;

  if (format === 'txt') {
    content = items
      .map((item) => {
        const sp = item.speaker ? `[${item.speaker}] ` : '';
        return `${item.timestamp || ''} ${sp}\nPL: ${item.pl || '-'}\nEN: ${item.en || '-'}\n`;
      })
      .join('\n');
  } else if (format === 'md') {
    content = `# Zapis Debaty (PL ➔ EN) — ${dateStr}\n\n` +
      items
        .map((item) => {
          const sp = item.speaker ? ` **(${item.speaker})**` : '';
          return `### ${item.timestamp || ''}${sp}\n- **EN:** ${item.en || ''}\n- **PL:** *${item.pl || ''}*\n`;
        })
        .join('\n');
  } else if (format === 'srt') {
    content = items
      .map((item, idx) => {
        const startSec = idx * 5;
        const endSec = startSec + 4;
        return `${idx + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${item.en || ''}\n`;
      })
      .join('\n');
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debata-tlumaczenie-${dateStr}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatSrtTime(totalSeconds) {
  const hrs = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs},000`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ensureOptionExists(selectEl, value) {
  if (!selectEl || !value) return;
  const exists = Array.from(selectEl.options).some((opt) => opt.value === value);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    selectEl.appendChild(opt);
  }
}

function populateModelDropdown(selectEl, modelsList, selectedValue) {
  if (!selectEl || !Array.isArray(modelsList) || modelsList.length === 0) return;
  selectEl.innerHTML = '';
  modelsList.forEach((m, idx) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = idx === 0 ? `${m} (Zalecany dla Twojego klucza)` : m;
    selectEl.appendChild(opt);
  });
  if (selectedValue) {
    ensureOptionExists(selectEl, selectedValue);
    selectEl.value = selectedValue;
  }
}

// Inicjalizacja przy starcie strony
async function initOperatorApp() {
  currentBgRecord = await loadBackgroundMedia();
  if (currentBgRecord?.fileName) {
    document.getElementById('bgFileInfo').textContent = `✓ Aktywne tło z dysku: ${currentBgRecord.fileName}`;
  }

  syncVoiceProfilesToLiveState();
  bindAppearanceControls();
  bindVoiceRecognitionControls();
  bindEngineAndContextControls();
  bindBannerControls();
  bindTransportAndActions();
  renderSpeakerChips();
  renderVoiceProfilesList();
  renderMiniPreview();
  renderTranscriptHistory();

  sync.onChange(() => {
    renderMiniPreview();
    renderTranscriptHistory();
    renderSpeakerChips();
  });

  window.addEventListener('resize', () => renderMiniPreview());
}

initOperatorApp();
