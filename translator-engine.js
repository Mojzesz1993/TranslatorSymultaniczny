import { getLanguageInfo } from './sync.js';

/**
 * translator-engine.js
 * Silnik rozpoznawania mowy (wielojęzyczny), analizy sygnału audio (VU-Meter + VAD)
 * oraz tłumaczenia kontekstowego na żywo (dowolna para języków) przez Google Gemini API.
 *
 * Obsługiwane tryby:
 * 1. 'hybrid'       : Web Speech API (wybrany język na żywo) + Gemini Flash (Live Draft + Final z kontekstem)
 * 2. 'gemini-audio' : Bezpośredni strumień Audio z wybranego wejścia -> Gemini Multimodal Audio (obsługuje też Auto-wykrywanie języka)
 * 3. 'demo'         : Symulacja debaty na żywo (do testowania ekranu, tła i czcionek bez mikrofonu/klucza)
 */

const DEMO_SCRIPT = [
  {
    speaker: 'Moderator',
    pl: 'Dzień dobry Państwu, otwieramy dzisiejszą debatę poświęconą przyszłości technologii i transformacji cyfrowej w Europie.',
    en: 'Good morning everyone, we are opening today’s debate dedicated to the future of technology and digital transformation in Europe.'
  },
  {
    speaker: 'Prelegent 1',
    pl: 'Dziękuję za głos. Kluczowym wyzwaniem na najbliższe lata jest połączenie szybkich innowacji ze stabilnym bezpieczeństwem energetycznym.',
    en: 'Thank you for the floor. The key challenge for the coming years is combining rapid innovation with stable energy security.'
  },
  {
    speaker: 'Prelegent 2',
    pl: 'Zgadzam się w pełni, natomiast z perspektywy przedsiębiorców najważniejsza jest dziś przewidywalność prawa oraz dostęp do wykwalifikowanych inżynierów.',
    en: 'I fully agree, however from the perspective of entrepreneurs, the most important factor today is regulatory predictability and access to qualified engineers.'
  },
  {
    speaker: 'Moderator',
    pl: 'A jak oceniają Państwo wpływ sztucznej inteligencji na polski rynek pracy w perspektywie najbliższych pięciu lat?',
    en: 'And how do you assess the impact of artificial intelligence on the Polish labor market over the next five years?'
  },
  {
    speaker: 'Prelegent 1',
    pl: 'Polska ma ogromny potencjał, aby stać się regionalnym liderem wdrożeń AI, jeśli dobrze wykorzystamy środki rozwojowe i współpracę z uczelniami.',
    en: 'Poland has tremendous potential to become a regional leader in AI adoption, provided we make good use of development funds and university collaboration.'
  }
];

export class DebateTranslatorEngine {
  constructor({ getApiConfig, getRecentContext, onDraftUpdate, onFinalSegment, onStatusChange, onAudioLevel, onError, onModelAutoSwitched, onAudioSourceReady, onAudioSourceStopped }) {
    this.getApiConfig = getApiConfig;
    this.getRecentContext = getRecentContext;
    this.onDraftUpdate = onDraftUpdate;
    this.onFinalSegment = onFinalSegment;
    this.onStatusChange = onStatusChange;
    this.onAudioLevel = onAudioLevel;
    this.onError = onError;
    this.onModelAutoSwitched = onModelAutoSwitched;
    this.onAudioSourceReady = onAudioSourceReady;
    this.onAudioSourceStopped = onAudioSourceStopped;

    this.isRunning = false;
    this.isMuted = false;

    // Web Audio API (VU-meter + opcjonalny zapis WAV/PCM dla trybu Gemini Audio)
    this.audioStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.audioMonitorRaf = null;
    this.scriptProcessor = null;
    this.pcmChunks = [];
    this.pcmSampleRate = 16000;
    this.speechDetectedInChunk = false;
    this.lastVoiceActivityTime = 0;
    this.chunkStartTime = 0;
    this.lastAudioDraftTime = 0;
    this.audioProcessingBusy = false;

    // Web Speech API (tryb Hybrydowy)
    this.recognition = null;
    this.currentInterimPl = '';
    this.currentInterimAlternatives = [];
    this.currentDraftEn = '';
    this.activeSegmentId = null;
    this.activeSegmentSpeaker = '';
    this.lastObservedResultIndex = 0;
    this.lastObservedTotalWords = 0;
    this.lastDraftRequestTime = 0;
    this.draftRequestInFlight = false;
    this.interimPauseTimer = null;
    this.speechWatchdogTimer = null;
    this.lastSpeechResultTime = 0;
    this.lastVoiceDetectedTime = 0;
    this.committedWordsByIndex = new Map();
    this.cachedDiscoveredModels = null;
    this.modelBlockedUntil = new Map();
    this.noThinkingConfigModels = new Set();
    this.activeFastModel = null;
    this.segmentStarts = new Map();
    this.lastSegmentEndMs = 0;
    this.audioRing = [];
    this.audioRingSamples = 0;
    this.outputChain = Promise.resolve();

    // Tryb Demo
    this.demoTimer = null;
    this.demoStepIndex = 0;
  }

  async start() {
    if (this.isRunning) return;
    const config = this.getApiConfig();

    if (config.engineMode !== 'demo' && !config.geminiApiKey?.trim()) {
      this.onError?.('Wprowadź klucz Google Gemini API w zakładce „Silnik AI i Audio” (lub przełącz na Tryb Demo, aby przetestować ekran).');
      return;
    }

    this.isRunning = true;
    this.isMuted = false;
    this.currentInterimPl = '';
    this.currentDraftEn = '';
    this.committedWordsByIndex.clear();
    this.lastSpeechResultTime = Date.now();

    if (config.engineMode === 'demo') {
      this.onStatusChange?.({ state: 'running', mode: 'demo', label: 'TRYB DEMO — Symulacja debaty na żywo' });
      this.startDemoMode();
      return;
    }

    // Uruchomienie mikrofonu / wejścia liniowego dla wskaźnika VU-Meter (oraz dla Gemini Audio)
    try {
      await this.startAudioCapture(config.audioDeviceId, config.engineMode === 'gemini-audio');
    } catch (err) {
      this.isRunning = false;
      this.onStatusChange?.({ state: 'error', label: 'Błąd dostępu do mikrofonu' });
      this.onError?.(`Nie udało się otworzyć wejścia audio: ${err.message || err}`);
      return;
    }

    if (config.engineMode === 'hybrid') {
      this.startWebSpeechHybrid();
    } else if (config.engineMode === 'gemini-audio') {
      this.onStatusChange?.({
        state: 'running',
        mode: 'gemini-audio',
        label: 'NASŁUCHIWANIE (Strumień Audio -> Gemini AI)'
      });
    }
  }

  stop() {
    this.isRunning = false;
    this.isMuted = false;
    clearTimeout(this.interimPauseTimer);

    if (this.speechWatchdogTimer) {
      clearInterval(this.speechWatchdogTimer);
      this.speechWatchdogTimer = null;
    }

    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }

    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        this.recognition.onresult = null;
        this.recognition.stop();
      } catch (_) {}
      this.recognition = null;
    }

    this.stopAudioCapture();
    this.onAudioLevel?.(0);
    this.onStatusChange?.({ state: 'stopped', label: 'ZATRZYMANO' });
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.isMuted) {
      this.onAudioLevel?.(0);
      this.onStatusChange?.({ state: 'muted', label: 'PAUZA / WYCISZONO WEJŚCIE' });
    } else if (this.isRunning) {
      const config = this.getApiConfig();
      this.onStatusChange?.({
        state: 'running',
        mode: config.engineMode,
        label: config.engineMode === 'demo'
          ? 'TRYB DEMO — Symulacja debaty na żywo'
          : 'NASŁUCHIWANIE NA ŻYWO (PL -> EN)'
      });
    }
  }

  /**
   * Przechwytywanie wybranego urządzenia wejściowego audio, wskaźnik wysterowania (VU-meter)
   * oraz buforowanie próbek PCM 16kHz dla trybu bezpośredniego Gemini Audio.
   */
  async startAudioCapture(deviceId, enablePcmRecording = false) {
    this.stopAudioCapture();

    // Sygnał z miksera / konsoli (mikrofony dynamiczne) jest już wysterowany i czysty —
    // przeglądarkowe AGC / odszumianie / AEC tylko by go zniekształcały, więc je wyłączamy.
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {})
      }
    };

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_) {
      // Fallback do domyślnego urządzenia, jeśli wybrany wcześniej interfejs został odłączony
      this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    const source = this.audioContext.createMediaStreamSource(this.audioStream);

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.65;
    source.connect(this.analyser);

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const updateMeter = () => {
      if (!this.isRunning || !this.analyser) return;
      if (this.isMuted) {
        this.onAudioLevel?.(0);
      } else {
        this.analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        // Przeskalowanie RMS na czytelny pasek 0-100%
        const level = Math.min(100, Math.round(Math.pow(rms * 4.5, 0.75) * 100));
        if (level > 15) {
          this.lastVoiceDetectedTime = Date.now();
        }
        this.onAudioLevel?.(level);
      }
      this.audioMonitorRaf = requestAnimationFrame(updateMeter);
    };
    this.audioMonitorRaf = requestAnimationFrame(updateMeter);

    // Jeśli aktywny jest tryb bezpośredniego przesyłania dźwięku do Gemini
    if (enablePcmRecording) {
      this.setupDirectAudioPipeline(source);
    } else {
      // Tryb hybrydowy: bufor kołowy audio 16 kHz ze znacznikami czasu — przy zamykaniu zdania
      // wycinamy dokładnie jego fragment i wysyłamy do Gemini razem z tekstem z Chrome.
      this.setupHybridAudioRing(source);
    }

    this.onAudioSourceReady?.(this.audioContext, source);
  }

  setupHybridAudioRing(sourceNode) {
    this.audioRing = [];
    this.audioRingSamples = 0;
    const bufferSize = 4096;
    const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    const inputSampleRate = this.audioContext.sampleRate;
    const blockMs = (bufferSize / inputSampleRate) * 1000;
    const maxSamples = 16000 * 45; // ostatnie 45 s

    processor.onaudioprocess = (event) => {
      if (!this.isRunning) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsampleBuffer(input, inputSampleRate, 16000);
      const endMs = Date.now();
      this.audioRing.push({ startMs: endMs - blockMs, endMs, pcm, muted: this.isMuted });
      this.audioRingSamples += pcm.length;
      while (this.audioRingSamples > maxSamples && this.audioRing.length > 1) {
        this.audioRingSamples -= this.audioRing.shift().pcm.length;
      }
    };

    const silent = this.audioContext.createGain();
    silent.gain.value = 0;
    sourceNode.connect(processor);
    processor.connect(silent);
    silent.connect(this.audioContext.destination);
    this.scriptProcessor = processor;
    this.ringSilentGain = silent;
  }

  /** Zwraca nagranie PCM 16 kHz z przedziału czasu [fromMs, toMs] (lub null). */
  sliceAudioRing(fromMs, toMs) {
    if (!this.audioRing || this.audioRing.length === 0) return null;
    const parts = this.audioRing.filter((c) => c.endMs > fromMs && c.startMs < toMs && !c.muted).map((c) => c.pcm);
    if (parts.length === 0) return null;
    const merged = mergeFloat32Arrays(parts);
    if (merged.length < 16000 * 0.5) return null;
    return merged.length > 16000 * 25 ? merged.slice(merged.length - 16000 * 25) : merged;
  }

  stopAudioCapture() {
    this.onAudioSourceStopped?.();
    if (this.audioMonitorRaf) {
      cancelAnimationFrame(this.audioMonitorRaf);
      this.audioMonitorRaf = null;
    }
    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch (_) {}
      this.scriptProcessor = null;
    }
    if (this.ringSilentGain) {
      try {
        this.ringSilentGain.disconnect();
      } catch (_) {}
      this.ringSilentGain = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (_) {}
      this.audioContext = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    this.pcmChunks = [];
    this.audioRing = [];
    this.audioRingSamples = 0;
  }

  /**
   * TRYB 1: Hybrydowy (Web Speech API pl-PL + Gemini Flash Context Translator)
   * Zawiera mechanizm samo-naprawy (Watchdog), dzięki któremu nasłuchiwanie nie zatrzymuje się
   * po kilku zdaniach ani po przekroczeniu 60-sekundowego limitu sesji w przeglądarce Chrome.
   */
  startWebSpeechHybrid() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      this.onError?.('Twoja przeglądarka nie obsługuje Web Speech API. Użyj Google Chrome lub Microsoft Edge, albo przełącz w ustawieniach na tryb „Bezpośredni Strumień Audio do Gemini”.');
      this.stop();
      return;
    }

    this.spawnRecognitionInstance();

    // Watchdog sprawdzający co 3s, czy przeglądarkowe rozpoznawanie mowy nie zawiesiło się po cichu
    // (nigdy nie przerywa sesji, gdy w buforze trwa rozpoznawanie aktualnego zdania!)
    if (this.speechWatchdogTimer) {
      clearInterval(this.speechWatchdogTimer);
    }
    this.speechWatchdogTimer = setInterval(() => {
      if (!this.isRunning || this.isMuted || this.getApiConfig().engineMode !== 'hybrid') return;
      if (this.currentInterimPl && this.currentInterimPl.trim().length > 0) return;
      const now = Date.now();
      const voiceActiveRecently = (now - this.lastVoiceDetectedTime) < 1800;
      const speechSilentTooLong = (now - this.lastSpeechResultTime) > 7500;

      // Jeśli mikrofon słyszy głos, a WebSpeech od ponad 7.5s nie przysłało żadnego zdarzenia — zrestartuj sesję
      if (voiceActiveRecently && speechSilentTooLong) {
        this.lastSpeechResultTime = now;
        this.spawnRecognitionInstance();
      }
    }, 3000);
  }

  /**
   * Pomocnik usuwający wcześniej zatwierdzony początek akapitu z pełnego tekstu Web Speech API.
   * Zamiast kruchego indeksowania po liczbie słów (które psuje się, gdy Chrome w drugiej fazie połączy
   * np. dwa słowa w jedno i zjada kolejne wypowiedziane słowa!), dopasowuje zatwierdzony prefiks elastycznie.
   */
  extractUncommittedWords(rawText, resultIndex) {
    const allWords = rawText.split(/\s+/).filter(Boolean);
    const committedInfo = this.committedWordsByIndex.get(resultIndex);
    if (!committedInfo) return allWords;

    const committedWords = Array.isArray(committedInfo)
      ? committedInfo
      : allWords.slice(0, Number(committedInfo) || 0);

    if (committedWords.length === 0) return allWords;

    // Znajdź koniec zatwierdzonego prefiksu (z tolerancją na korekty końcówek przez model językowy Chrome)
    const targetLen = committedWords.length;
    const lastCommittedWord = (committedWords[targetLen - 1] || '').toLowerCase().replace(/[.,!?]/g, '');

    // Sprawdź w oknie +/- 2 słów wokół targetLen, gdzie dokładnie kończy się ostatnie zatwierdzone słowo
    for (let offset = 0; offset <= 2; offset++) {
      for (const dir of [0, -1, 1]) {
        const idx = targetLen - 1 + dir * offset;
        if (idx >= 0 && idx < allWords.length) {
          const candidate = allWords[idx].toLowerCase().replace(/[.,!?]/g, '');
          if (
            candidate === lastCommittedWord ||
            (candidate.length >= 4 && lastCommittedWord.length >= 4 && candidate.slice(0, 4) === lastCommittedWord.slice(0, 4))
          ) {
            return allWords.slice(idx + 1);
          }
        }
      }
    }

    return allWords.slice(Math.min(targetLen, allWords.length));
  }

  spawnRecognitionInstance() {
    if (!this.isRunning || this.getApiConfig().engineMode !== 'hybrid') return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        this.recognition.onresult = null;
        this.recognition.abort();
      } catch (_) {}
      this.recognition = null;
    }

    this.committedWordsByIndex.clear();
    const recognition = new SpeechRec();
    const srcLangInfo = getLanguageInfo(this.getApiConfig().sourceLang || 'pl');
    recognition.lang = srcLangInfo.bcp47 || 'pl-PL';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    recognition.onstart = () => {
      if (!this.isRunning) return;
      this.lastSpeechResultTime = Date.now();
      const cfg = this.getApiConfig();
      const sCode = (cfg.sourceLang || 'pl').toUpperCase();
      const tCode = (cfg.targetLang || 'en').toUpperCase();
      this.onStatusChange?.({
        state: this.isMuted ? 'muted' : 'running',
        mode: 'hybrid',
        label: this.isMuted ? 'PAUZA / WYCISZONO' : `NASŁUCHIWANIE NA ŻYWO (Hybryda: Web Speech ${sCode} ➔ ${tCode})`
      });
    };

    recognition.onresult = (event) => {
      if (!this.isRunning || this.isMuted) return;
      this.lastSpeechResultTime = Date.now();

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const rawText = (res[0]?.transcript || '').trim();
        if (!rawText) continue;

        const allWords = rawText.split(/\s+/).filter(Boolean);
        const remainingWords = this.extractUncommittedWords(rawText, i);
        const cleanSegment = remainingWords.join(' ').trim();

        // Zbierz do 4 alternatywnych hipotez akustycznych dla tego samego fragmentu (pomaga Gemini naprawić homofony!)
        const altTranscripts = [];
        for (let a = 1; a < res.length; a++) {
          const altRaw = (res[a]?.transcript || '').trim();
          if (altRaw && altRaw !== rawText) {
            const altRemaining = this.extractUncommittedWords(altRaw, i).join(' ').trim();
            if (altRemaining && altRemaining !== cleanSegment) {
              altTranscripts.push(altRemaining);
            }
          }
        }

        this.lastObservedResultIndex = i;
        this.lastObservedTotalWords = allWords.slice();

        if (res.isFinal) {
          // Główna ścieżka najwyższej dokładności: Chrome zakończył drugie przebiegowe modelowanie języka polskiego (Second-Pass Rescoring)!
          clearTimeout(this.interimPauseTimer);
          this.interimPauseTimer = null;
          this.committedWordsByIndex.set(i, allWords.slice());
          const segmentId = this.activeSegmentId || ('seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
          const lockedSpeaker = this.activeSegmentSpeaker || '';
          this.currentInterimPl = '';
          this.currentInterimAlternatives = [];
          this.currentDraftEn = '';
          this.lastDraftWordCount = 0;
          this.activeSegmentId = null;

          if (cleanSegment.length > 1) {
            this.finalizePolishSegment(cleanSegment, '', segmentId, lockedSpeaker, altTranscripts);
          }
        } else {
          // Wynik pośredni (interim) w trakcie mówienia — NIGDY nie tnij go w locie (0ms) w połowie wymawianego słowa!
          if (!cleanSegment) continue;

          if (!this.activeSegmentId) {
            this.activeSegmentId = 'seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
            this.lastDraftWordCount = 0;
            // Chrome zgłasza pierwsze słowa z opóźnieniem ~0.5–1 s — cofamy początek nagrania o 1.5 s,
            // ale nie wcześniej niż koniec poprzedniego zdania (żeby nie dołączać cudzej wypowiedzi).
            this.segmentStarts.set(this.activeSegmentId, Math.max(this.lastSegmentEndMs || 0, Date.now() - 1500));
          }
          const prevInterimPl = this.currentInterimPl;
          const textActuallyChanged = cleanSegment !== prevInterimPl;

          this.currentInterimPl = cleanSegment;
          this.currentInterimAlternatives = altTranscripts;

          // Pokaż rozpoznawany polski tekst w lokalnym podglądzie operatora
          this.onDraftUpdate?.({
            id: this.activeSegmentId,
            pl: cleanSegment,
            en: '',
            speaker: this.activeSegmentSpeaker || '',
            plOnly: true
          });

          const wordCount = remainingWords.length;

          // Czekamy na naturalne zakończenie wypowiadanych słów:
          // - przy długiej wypowiedzi (>= 12 słów) wystarczy wyraźna pauza oddechowa (820ms), kiedy ostatnie słowo już się ustabilizowało,
          // - przy krótszym zdaniu dajemy pierwszeństwo natywnemu res.isFinal z Chrome (~850-1000ms), a timer (1350ms) działa jako bezpiecznik.
          if (textActuallyChanged || !this.interimPauseTimer) {
            clearTimeout(this.interimPauseTimer);
            const capturedIndex = i;
            const capturedWordsSnapshot = allWords.slice();
            const pauseDelayMs = wordCount >= 12 ? 820 : 1350;
            this.interimPauseTimer = setTimeout(() => {
              this.interimPauseTimer = null;
              if (this.currentInterimPl && this.currentInterimPl.split(/\s+/).length >= 2) {
                this.committedWordsByIndex.set(capturedIndex, capturedWordsSnapshot);
                const segmentToCommit = this.currentInterimPl;
                const segmentId = this.activeSegmentId;
                const lockedSpeaker = this.activeSegmentSpeaker || '';
                const alts = this.currentInterimAlternatives || [];
                this.currentInterimPl = '';
                this.currentInterimAlternatives = [];
                this.currentDraftEn = '';
                this.lastDraftWordCount = 0;
                this.activeSegmentId = null;
                this.finalizePolishSegment(segmentToCommit, '', segmentId, lockedSpeaker, alts);
              }
            }, pauseDelayMs);
          }
        }
      }
    };

    recognition.onerror = (event) => {
      if (!this.isRunning) return;
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      console.warn('WebSpeech warning:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.onError?.('Brak uprawnień do mikrofonu w przeglądarce. Zezwól na dostęp do mikrofonu na pasku adresu.');
        this.stop();
      }
    };

    recognition.onend = () => {
      if (this.isRunning && this.getApiConfig().engineMode === 'hybrid') {
        // Jeśli przed zamknięciem sesji został niezatwierdzony tekst w buforze, sfinalizuj go
        if (this.currentInterimPl && this.currentInterimPl.trim().length > 2) {
          const leftoverPl = this.currentInterimPl.trim();
          const leftoverEn = this.currentDraftEn;
          const segId = this.activeSegmentId;
          const lockedSpeaker = this.activeSegmentSpeaker || '';
          const alts = this.currentInterimAlternatives || [];
          this.currentInterimPl = '';
          this.currentInterimAlternatives = [];
          this.currentDraftEn = '';
          this.activeSegmentId = null;
          this.finalizePolishSegment(leftoverPl, leftoverEn, segId, lockedSpeaker, alts);
        }
        // Natychmiast utwórz świeżą sesję nasłuchiwania
        setTimeout(() => {
          if (this.isRunning && this.getApiConfig().engineMode === 'hybrid') {
            this.spawnRecognitionInstance();
          }
        }, 120);
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (err) {
      setTimeout(() => {
        if (this.isRunning && this.getApiConfig().engineMode === 'hybrid') {
          this.spawnRecognitionInstance();
        }
      }, 300);
    }
  }

  /**
   * Wywoływane automatycznie w chwili wykrycia zmiany głosu mówcy (lub ręcznego przełączenia mówcy).
   * - Jeśli w buforze jest dopiero początek nowego zdania (1-6 słów wypowiedzianych w ostatniej sekundzie),
   *   przypisuje te słowa WSTECZNIE do nowo rozpoznanego mówcy (dzięki czemu pierwsze słowa nowego mówcy
   *   nie dostają etykiety poprzedniej osoby!).
   * - Jeśli w buforze jest już dłuższa kwestia poprzedniego mówcy (>= 7 słów), zamyka ją pod starym mówcą
   *   i otwiera czystą kwestię dla nowego mówcy.
   */
  handleSpeakerChange(newSpeaker, previousSpeaker = '') {
    if (!this.isRunning || this.isMuted) {
      this.activeSegmentSpeaker = newSpeaker || '';
      return;
    }

    const config = this.getApiConfig();

    if (config.engineMode === 'hybrid') {
      const interimWords = (this.currentInterimPl || '').trim().split(/\s+/).filter(Boolean);
      if (interimWords.length >= 7) {
        // W buforze jest dłuższa wypowiedź poprzedniego mówcy — zamknij ją jako jego kwestię
        clearTimeout(this.interimPauseTimer);
        this.committedWordsByIndex.set(this.lastObservedResultIndex, this.lastObservedTotalWords);
        const segmentToCommit = this.currentInterimPl.trim();
        const lastDraftEn = this.currentDraftEn;
        const segmentId = this.activeSegmentId || ('seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
        const speakerForOldSegment = previousSpeaker || this.activeSegmentSpeaker || '';
        const alts = this.currentInterimAlternatives || [];

        this.currentInterimPl = '';
        this.currentInterimAlternatives = [];
        this.currentDraftEn = '';
        this.lastDraftWordCount = 0;
        this.activeSegmentId = null;
        this.activeSegmentSpeaker = newSpeaker || '';

        this.finalizePolishSegment(segmentToCommit, lastDraftEn, segmentId, speakerForOldSegment, alts);
        return;
      } else if (interimWords.length >= 1) {
        // W buforze jest 1-6 słów z ostatniej ~1 sekundy — to początek wypowiedzi NOWEGO mówcy!
        // Natychmiast zaktualizuj podpis mówcy dla bieżącego zdania bez jego dzielenia.
        this.activeSegmentSpeaker = newSpeaker || '';
        if (this.activeSegmentId) {
          this.onDraftUpdate?.({
            id: this.activeSegmentId,
            pl: this.currentInterimPl,
            en: this.currentDraftEn || '',
            speaker: this.activeSegmentSpeaker,
            plOnly: !this.currentDraftEn
          });
        }
        return;
      }
    }

    // 2. W trybie bezpośredniego Strumienia Audio do Gemini: jeśli nagrało się już >1.4s wypowiedzi poprzedniego mówcy, wyślij ją osobno
    if (config.engineMode === 'gemini-audio' && this.speechDetectedInChunk && this.pcmChunks.length > 0) {
      const chunkDurationMs = Date.now() - this.chunkStartTime;
      if (chunkDurationMs >= 1400) {
        const finalPcm = mergeFloat32Arrays(this.pcmChunks);
        const speakerForOldSegment = previousSpeaker || this.activeSegmentSpeaker || '';
        this.pcmChunks = [];
        this.speechDetectedInChunk = false;
        this.chunkStartTime = Date.now();
        this.activeSegmentSpeaker = newSpeaker || '';
        this.processAudioWithGemini(finalPcm, 16000, false, speakerForOldSegment);
        return;
      }
    }

    this.activeSegmentSpeaker = newSpeaker || '';
  }

  /**
   * TRYB 2: Bezpośredni Strumień Audio do Gemini (VAD + bufor PCM -> WAV -> Gemini Multimodal)
   */
  setupDirectAudioPipeline(sourceNode) {
    const bufferSize = 4096;
    const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    const inputSampleRate = this.audioContext.sampleRate;

    this.pcmChunks = [];
    this.speechDetectedInChunk = false;
    this.chunkStartTime = Date.now();
    this.lastVoiceActivityTime = Date.now();
    this.lastAudioDraftTime = 0;

    processor.onaudioprocess = (event) => {
      if (!this.isRunning || this.isMuted) return;
      const inputData = event.inputBuffer.getChannelData(0);

      // Oblicz energię RMS dla detekcji mowy (VAD)
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);
      const now = Date.now();
      const isSpeakingNow = rms > 0.014;

      if (isSpeakingNow) {
        if (!this.speechDetectedInChunk) {
          this.chunkStartTime = now;
        }
        this.speechDetectedInChunk = true;
        this.lastVoiceActivityTime = now;
      }

      if (this.speechDetectedInChunk) {
        // Downsample do 16kHz Mono PCM, aby pakiety do Gemini były lekkie i błyskawiczne
        const downsampled = downsampleBuffer(inputData, inputSampleRate, 16000);
        this.pcmChunks.push(downsampled);

        const chunkDurationMs = now - this.chunkStartTime;
        const silenceDurationMs = now - this.lastVoiceActivityTime;
        const config = this.getApiConfig();
        const vadSilenceLimit = Math.min(900, Number(config.vadSilenceMs) || 850);

        // Finalizacja zdania po naturalnej pauzie mówcy (~0.85s) lub osiągnięciu 5.5 sekundy ciągłej mowy (bez pośrednich draftów)
        if (
          (silenceDurationMs >= vadSilenceLimit && chunkDurationMs >= 550) ||
          chunkDurationMs >= 5500
        ) {
          const finalPcm = mergeFloat32Arrays(this.pcmChunks);
          const lockedSpeaker = this.activeSegmentSpeaker || '';
          this.pcmChunks = [];
          this.speechDetectedInChunk = false;
          this.chunkStartTime = now;
          this.processAudioWithGemini(finalPcm, 16000, false, lockedSpeaker);
        }
      }
    };

    sourceNode.connect(processor);
    processor.connect(this.audioContext.destination);
    this.scriptProcessor = processor;
  }

  async processAudioWithGemini(float32Pcm, sampleRate, isDraft = false, lockedSpeaker = '') {
    if (!float32Pcm || float32Pcm.length < sampleRate * 0.35) return;
    if (isDraft && this.audioProcessingBusy) return;

    this.audioProcessingBusy = true;
    try {
      const wavBase64 = encodeWAVBase64(float32Pcm, sampleRate);
      const config = this.getApiConfig();
      const recentContext = this.getRecentContext?.() || [];

      const systemPrompt = this.buildSystemInstruction(config, recentContext, true, lockedSpeaker);
      const srcInfo = getLanguageInfo(config.sourceLang || 'pl');
      const tgtInfo = getLanguageInfo(config.targetLang || 'en');
      const srcLabel = config.sourceLang === 'auto' ? 'rozpoznany język z nagrania' : srcInfo.namePl;
      const userPrompt = isDraft
        ? `Spisz dotychczasową wypowiedź z nagrania audio (${srcLabel}) i przetłumacz ją na język: ${tgtInfo.namePl} (${tgtInfo.nameEn}) zgodnie z ZASADAMI TŁUMACZENIA z instrukcji systemowej. Zwróć JSON: {"pl": "rozpoznany tekst źródłowy", "en": "tłumaczenie w języku ${tgtInfo.namePl}"}. Jeśli w nagraniu jest wyłącznie cisza lub szum, zwróć {"pl": "", "en": ""}.`
        : `Spisz wypowiedź z nagrania audio (${srcLabel}) i przetłumacz ją na język: ${tgtInfo.namePl} (${tgtInfo.nameEn}) zgodnie z ZASADAMI TŁUMACZENIA z instrukcji systemowej. Zwróć wyłącznie JSON: {"pl": "dokładny tekst źródłowy", "en": "tłumaczenie w języku ${tgtInfo.namePl}"}. Jeśli w nagraniu nie ma mowy, zwróć {"pl": "", "en": ""}.`;

      const model = config.geminiModel || 'gemini-flash-latest';
      const data = await this.callGeminiWithAutoFallback(config.geminiApiKey.trim(), model, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
              { text: userPrompt }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      let parsed = {};
      try {
        parsed = JSON.parse(rawText);
      } catch (_) {}

      const pl = (parsed.pl || '').trim();
      const en = (parsed.en || '').trim();

      if (!pl && !en) return;

      if (isDraft) {
        if (!this.activeSegmentId) {
          this.activeSegmentId = 'seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        }
        this.currentDraftEn = en;
        this.onDraftUpdate?.({ id: this.activeSegmentId, pl, en, speaker: lockedSpeaker });
      } else {
        const segId = this.activeSegmentId || ('seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
        this.activeSegmentId = null;
        this.currentDraftEn = '';
        this.onFinalSegment?.({ id: segId, pl, en, speaker: lockedSpeaker });
      }
    } catch (err) {
      console.error('Gemini Audio Error:', err);
      if (!isDraft) {
        this.onError?.(err.message || 'Błąd komunikacji z Gemini Audio API');
      }
    } finally {
      this.audioProcessingBusy = false;
    }
  }

  /**
   * Tłumaczenie Live Draft (w trakcie mówienia zdania).
   * Używa silnika niskiej latencji (~120ms), dzięki czemu pierwsze słowa pojawiają się na ekranie
   * natychmiast (0.2s) w trakcie mówienia, a 100% puli zapytań Gemini API jest zachowane na błyskawiczne
   * tłumaczenie konferencyjne całych segmentów (co 10-14 słów lub po pauzie 0.68s).
   */
  async translateDraftSegment(polishDraft, segmentId, speakerName = '') {
    if (!polishDraft || polishDraft.trim().length < 2) return;
    this.draftRequestInFlight = true;
    try {
      const translatedEn = await this.fallbackTranslatePlToEn(polishDraft);
      if (translatedEn && this.currentInterimPl && this.activeSegmentId === segmentId) {
        this.currentDraftEn = translatedEn;
        this.onDraftUpdate?.({
          id: segmentId,
          pl: this.currentInterimPl,
          en: translatedEn,
          speaker: this.activeSegmentSpeaker || speakerName || ''
        });
      }
    } catch (err) {
      console.warn('Draft translation warning:', err);
    } finally {
      this.draftRequestInFlight = false;
    }
  }

  /**
   * Finalizacja zakończonego zdania.
   * 1. Wycina z bufora kołowego nagranie tego zdania i wysyła je do Gemini razem z tekstem z Chrome —
   *    Gemini słyszy oryginał, poprawia przesłyszane słowa i tłumaczy (ścieżka główna).
   * 2. Jeśli audio jest niedostępne / ciche albo zapytanie się nie powiedzie — tłumaczenie samego tekstu.
   * 3. Napisy są emitowane w kolejności wypowiedzi, nawet gdy odpowiedzi API wrócą w innej kolejności.
   */
  finalizePolishSegment(polishSentence, lastDraftEn = '', segmentId = null, lockedSpeaker = '', altTranscripts = []) {
    const cleanPl = (polishSentence || '').trim();
    if (!cleanPl) return;

    const finalId = segmentId || ('seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const endMs = Date.now();
    const startMs = this.segmentStarts.get(finalId) ?? Math.max(this.lastSegmentEndMs || 0, endMs - 8000);
    this.segmentStarts.delete(finalId);
    this.lastSegmentEndMs = endMs;
    const audioPcm = this.sliceAudioRing(startMs, endMs);

    const resultPromise = (async () => {
      if (audioPcm && pcmRms(audioPcm) > 0.004) {
        try {
          const res = await this.translateSegmentWithAudio(audioPcm, cleanPl, altTranscripts, lockedSpeaker);
          if (res && res.en) return { pl: res.pl || cleanPl, en: res.en };
        } catch (err) {
          console.warn('Audio+tekst do Gemini nie powiodło się, tłumaczę sam tekst:', err.message);
        }
      }
      try {
        const en = await this.translatePolishTextToEnglish(cleanPl, false, '', true, lockedSpeaker, altTranscripts);
        if (en && en.trim()) return { pl: cleanPl, en: en.trim() };
      } catch (_) {}
      const backupEn = await this.fallbackTranslatePlToEn(cleanPl);
      return backupEn ? { pl: cleanPl, en: backupEn.trim() } : null;
    })();

    this.outputChain = this.outputChain
      .then(() => resultPromise)
      .then((result) => {
        if (result && result.en) {
          this.onFinalSegment?.({ id: finalId, pl: result.pl, en: result.en, speaker: lockedSpeaker, isUpdate: false });
        }
      })
      .catch((err) => console.warn('Segment output error:', err));
  }

  /**
   * Gemini słucha nagrania zdania + dostaje roboczy zapis z Chrome i kontekst debaty.
   * Zwraca { pl: poprawiona transkrypcja, en: tłumaczenie }.
   */
  async translateSegmentWithAudio(float32Pcm, asrText, altTranscripts = [], speakerName = '') {
    const config = this.getApiConfig();
    const apiKey = (config.geminiApiKey || '').trim();
    if (!apiKey) return null;

    const recentContext = this.getRecentContext?.() || [];
    const systemInstruction = this.buildSystemInstruction(config, recentContext, true, speakerName);
    const alts = Array.isArray(altTranscripts) && altTranscripts.length > 0
      ? `\nAlternatywne hipotezy z rozpoznawania mowy:\n- ${altTranscripts.slice(0, 4).join('\n- ')}`
      : '';

    const srcInfo = getLanguageInfo(config.sourceLang || 'pl');
    const tgtInfo = getLanguageInfo(config.targetLang || 'en');
    const srcLabel = config.sourceLang === 'auto' ? 'język mówiony z nagrania' : srcInfo.namePl;

    const prompt = `Załączone nagranie to jedna wypowiedź z debaty (${srcLabel} ➔ ${tgtInfo.namePl})${speakerName ? ` (mówi: ${speakerName})` : ''}.
Roboczy zapis z automatycznego rozpoznawania mowy (może zawierać przesłyszane słowa, brak interpunkcji):
"${asrText}"${alts}

ZADANIE:
1. "pl": wiernie spisz w języku źródłowym (${srcLabel}) to, co faktycznie słychać w nagraniu. Zapis roboczy traktuj jako podpowiedź — gdy nagranie brzmi inaczej, ufaj nagraniu. Nazwy własne zapisuj tak, jak brzmią (lub zgodnie ze słowniczkiem) — nigdy nie podmieniaj ich na inne marki czy produkty. Pomiń fragmenty, które ewidentnie należą do poprzedniego zdania (początek nagrania może zawierać jego końcówkę — patrz [KONTEKST]). Pomiń wtrącenia zawahania ("yyy", "eee", "uhm"). Nie dodawaj kropki, jeśli myśl jest urwana.
2. "en": przetłumacz ten tekst na język ${tgtInfo.namePl} (${tgtInfo.nameEn}) zgodnie z ZASADAMI TŁUMACZENIA z instrukcji systemowej (zero halucynacji nazw, korekta błędów ASR, wypełniacze mowy potocznej, otwarta struktura urwanych fragmentów, naturalny konwersacyjny ton).
Jeśli nagranie jest nieczytelne, oprzyj się na zapisie roboczym.`;

    const data = await this.callGeminiWithAutoFallback(apiKey, config.geminiModel || 'gemini-flash-latest', {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: encodeWAVBase64(float32Pcm, 16000) } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { pl: { type: 'STRING' }, en: { type: 'STRING' } },
          required: ['pl', 'en']
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, { timeoutMs: 6500, maxFallbacks: 1 });

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = (parts.find((p) => typeof p.text === 'string' && !p.thought) || {}).text || '';
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return null;
    }
    return { pl: (parsed.pl || '').trim(), en: (parsed.en || '').trim() };
  }

  /**
   * Profesjonalne tłumaczenie symultaniczne PL -> EN przez Google Gemini API (czysto tekstowe, <1.5 KB, latencja ~0.35s):
   * - Rekonstruuje błędy fonetyczne z rozpoznawania mowy (korzystając z kontekstu debaty i hipotez alternatywnych ASR)
   * - Tłumaczy sens, idiomy i styl ekspercki na naturalny, konferencyjny język angielski
   * - Pamięta aktywny działający model i obsługę thinkingConfig, eliminując powtórne próby sieciowe
   */
  async translatePolishTextToEnglish(
    polishText,
    isDraft = false,
    previousDraftEn = '',
    allowBackup = true,
    speakerName = '',
    altTranscripts = []
  ) {
    const config = this.getApiConfig();
    const apiKey = (config.geminiApiKey || '').trim();
    if (!apiKey) {
      if (allowBackup) {
        return this.fallbackTranslatePlToEn(polishText);
      }
      throw new Error('Brak klucza Gemini API.');
    }

    const recentContext = this.getRecentContext?.() || [];
    const systemInstruction = this.buildSystemInstruction(config, recentContext, false, speakerName);

    const altsBlock = Array.isArray(altTranscripts) && altTranscripts.length > 0
      ? `\nAlternatywne hipotezy akustyczne z mikrofonu (jeśli w głównym tekście słowo brzmi nielogicznie lub zostało przekręcone fonetycznie, użyj właściwego słowa z poniższych hipotez):\n- ${altTranscripts.slice(0, 4).join('\n- ')}`
      : '';

    const srcInfo = getLanguageInfo(config.sourceLang || 'pl');
    const tgtInfo = getLanguageInfo(config.targetLang || 'en');
    const srcLabel = config.sourceLang === 'auto' ? 'język źródłowy' : srcInfo.namePl;

    const prompt = isDraft
      ? `Przetłumacz symultanicznie na żywo poniższy fragment wypowiedzi (${srcLabel} -> ${tgtInfo.namePl} / ${tgtInfo.nameEn}) na naturalny, profesjonalny, konferencyjny język ${tgtInfo.namePl}. Zwróć wyłącznie sam przetłumaczony tekst:\n\n${polishText}`
      : `Przetłumacz poniższy fragment wypowiedzi (${srcLabel} -> ${tgtInfo.namePl} / ${tgtInfo.nameEn}) zgodnie z ZASADAMI TŁUMACZENIA z instrukcji systemowej (zero halucynacji nazw, korekta błędów ASR, naturalna adaptacja mowy potocznej, otwarta struktura urwanych fragmentów).
Zwróć WYŁĄCZNIE gotowe tłumaczenie w języku docelowym: ${tgtInfo.namePl} (${tgtInfo.nameEn}) — bez cudzysłowów i bez komentarzy.

Fragment źródłowy${speakerName ? ` (${speakerName})` : ''}:
${polishText}${altsBlock}`;

    const model = config.geminiModel || 'gemini-flash-latest';
    try {
      const data = await this.callGeminiWithAutoFallback(apiKey, model, {
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 512,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => typeof p.text === 'string' && !p.thought) || parts[0];
      const output = textPart?.text || '';
      const cleaned = output.trim().replace(/^["„”]+|["„”]+$/g, '');
      if (cleaned) return cleaned;
    } catch (err) {
      if (!allowBackup) throw err;
      console.warn('Gemini limit/timeout — używam tłumaczenia zapasowego:', err.message);
    }

    if (allowBackup) {
      return this.fallbackTranslatePlToEn(polishText);
    }
    return '';
  }

  /**
   * Błyskawiczne tłumaczenie niskiej latencji (~120ms) dla Live Draft w trakcie mówienia
   * oraz jako zabezpieczenie awaryjne.
   */
  async fallbackTranslatePlToEn(polishText) {
    const clean = (polishText || '').trim();
    if (!clean) return '';
    const config = this.getApiConfig();
    const sl = config.sourceLang || 'pl';
    const tl = config.targetLang || 'en';

    // 1. Próba przez lokalny serwer Pythona (/api/translate-fallback)
    try {
      const res = await fetch('/api/translate-fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, sl, tl })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.en) return data.en.trim();
      }
    } catch (_) {}

    // 2. Bezpośredni fallback z przeglądarki
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(clean)}`;
      const res = await fetch(url);
      if (res.ok) {
        const arr = await res.json();
        const translated = (arr?.[0] || []).map((part) => part?.[0] || '').join('');
        if (translated.trim()) return translated.trim();
      }
    } catch (_) {}

    return '';
  }

  /**
   * Wywołanie Gemini generateContent z pamięcią kondycji modeli:
   * - pamięta modele niedostępne (404) i chwilowo objęte limitem (429/503), więc kolejne zdania idą od razu do działającego modelu,
   * - wyłącza „myślenie” modelu (thinkingBudget: 0 dla 2.x, thinkingLevel: low dla 3.x) — jeśli model odrzuci parametr (400),
   *   ponawia bez niego i zapamiętuje to dla danego modelu.
   * options.timeoutMs — limit czasu pojedynczego zapytania; options.maxFallbacks — ile modeli zapasowych próbować.
   */
  async callGeminiWithAutoFallback(apiKey, preferredModel, bodyPayload, options = {}) {
    const timeoutMs = options.timeoutMs || 3000;
    const maxFallbacks = options.maxFallbacks ?? 2;
    const now = Date.now();
    const cleanPreferred = (preferredModel || 'gemini-flash-latest').replace(/^models\//, '');

    const isModelBlocked = (m) => (this.modelBlockedUntil.get(m) || 0) > Date.now();

    const primaryModel = (!isModelBlocked(cleanPreferred))
      ? cleanPreferred
      : (this.activeFastModel && !isModelBlocked(this.activeFastModel) ? this.activeFastModel : cleanPreferred);

    const withoutThinking = (payload) => {
      const cloned = { ...payload, generationConfig: { ...payload.generationConfig } };
      delete cloned.generationConfig.thinkingConfig;
      return cloned;
    };

    const preparePayloadForModel = (modelId) => {
      if (!bodyPayload?.generationConfig?.thinkingConfig) return bodyPayload;
      if (this.noThinkingConfigModels.has(modelId)) return withoutThinking(bodyPayload);
      if (/gemini-3/.test(modelId)) {
        return {
          ...bodyPayload,
          generationConfig: { ...bodyPayload.generationConfig, thinkingConfig: { thinkingLevel: 'low' } }
        };
      }
      return bodyPayload;
    };

    const sendRequest = async (modelId, payload) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        return await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const tryModel = async (modelId) => {
      const payloadForModel = preparePayloadForModel(modelId);
      let res = await sendRequest(modelId, payloadForModel);
      if (res.status === 400 && payloadForModel?.generationConfig?.thinkingConfig) {
        this.noThinkingConfigModels.add(modelId);
        res = await sendRequest(modelId, withoutThinking(payloadForModel));
      }
      if (res.status === 404) {
        this.modelBlockedUntil.set(modelId, Date.now() + 3600_000); // zablokuj na 1h
      } else if (res.status === 429 || res.status === 503) {
        this.modelBlockedUntil.set(modelId, Date.now() + 45_000); // zablokuj na 45s przy limicie RPM
      } else if (res.ok) {
        this.activeFastModel = modelId;
      }
      return res;
    };

    let response;
    let primaryStatus = 0;
    try {
      response = await tryModel(primaryModel);
      primaryStatus = response.status;
      if (response.ok) {
        return response.json();
      }
    } catch (_) {
      this.modelBlockedUntil.set(primaryModel, now + 20_000);
      primaryStatus = 503;
    }

    if (primaryStatus === 404 || primaryStatus === 429 || primaryStatus === 503) {
      // Szybka lista zapasowa (maksymalnie 2 próby na zdanie, aby nigdy nie blokować napisów!)
      const fastFallbacks = [
        this.activeFastModel,
        'gemini-2.5-flash-lite',
        'gemini-flash-latest',
        'gemini-2.0-flash',
        'gemini-3.1-flash-lite-preview',
        'gemini-3-flash-preview'
      ].filter((m, idx, arr) => m && m !== primaryModel && !isModelBlocked(m) && arr.indexOf(m) === idx);

      for (const candidate of fastFallbacks.slice(0, maxFallbacks)) {
        try {
          const retryRes = await tryModel(candidate);
          if (retryRes.ok) {
            if (primaryStatus === 404 && primaryModel === cleanPreferred) {
              this.onModelAutoSwitched?.(candidate, this.cachedDiscoveredModels || []);
            }
            return retryRes.json();
          }
        } catch (_) {
          this.modelBlockedUntil.set(candidate, Date.now() + 20_000);
        }
      }
    }

    if (!response || !response.ok) {
      const errBody = response ? await response.text() : 'Przekroczono czas oczekiwania (timeout)';
      throw new Error(`Kod ${response ? response.status : 'TIMEOUT'}: ${errBody.slice(0, 220)}`);
    }

    return response.json();
  }

  /**
   * Pobiera listę modeli obsługiwanych przez dany klucz Gemini API i sortuje je
   * od najlepszych modeli Flash przeznaczonych do tłumaczenia symultanicznego.
   */
  async discoverAvailableModels(apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const models = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter((name) => name.startsWith('gemini-') && !name.includes('embedding') && !name.includes('imagen') && !name.includes('veo') && !name.includes('tts'));

      // Sortuj tak, aby pełne modele Flash (najlepsza jakość + niska latencja) były przed modelami Lite
      const scoreModel = (name) => {
        if (name === 'gemini-flash-latest') return 100;
        if (name === 'gemini-3-flash-preview' || name === 'gemini-2.5-flash') return 96;
        if (name.includes('flash') && !name.includes('lite') && !name.includes('8b')) return 90;
        if (name.includes('pro')) return 80;
        if (name.includes('flash-lite')) return 70;
        return 10;
      };

      return models.sort((a, b) => scoreModel(b) - scoreModel(a));
    } catch (_) {
      return [];
    }
  }

  buildSystemInstruction(config, recentContext = [], isAudio = false, speakerName = '') {
    const srcCode = config.sourceLang || 'pl';
    const tgtCode = config.targetLang || 'en';
    const srcInfo = getLanguageInfo(srcCode);
    const tgtInfo = getLanguageInfo(tgtCode);
    const isPolishSource = srcCode === 'pl';

    const contextLines = recentContext
      .slice(-6)
      .map((item) => {
        const spk = item.speaker ? `[${item.speaker}] ` : '';
        return `- ${spk}SRC: ${item.pl}\n  TGT: ${item.en}`;
      })
      .join('\n');

    const srcDesc = srcCode === 'auto'
      ? 'dowolnego wykrytego języka mówionego'
      : `języka ${srcInfo.namePl} (${srcInfo.nameEn})`;

    const polishSpecificAsr = isPolishSource
      ? [
          '2. ADAPTACJA SLANGU I KOREKTA ASR (IT CONTEXT): Zawsze tłumacz intencję techniczną opartą o logikę branżową oraz [SŁOWNIK KONTEKSTOWY]. Naprawiaj błędy fonetyczne ASR przed tłumaczeniem. Na przykład:',
          '   - "rysiem" / "rys" w kontekście wdrożeń -> "release" (nie "lynx")',
          '   - "intuicja" w kontekście zarządzania urządzeniami -> "Intune"',
          '   - "obrońca" w kontekście bezpieczeństwa -> "Defender"',
          '   - "w obozie" / "ażur" w kontekście chmury -> "Azure"',
          '   - "Lecimy z tym koksem" -> "Let\'s get to work" / "Let\'s get down to business"',
          '   - Slang oceniający ("patologia", "przejebana sprawa", "rzeźba", "druciarstwo") w odniesieniu do projektu lub podatności tłumacz jako "massive mess", "complete disaster" lub "awful workaround" (lub odpowiednik w języku docelowym). Zachowaj emocjonalny wydźwięk, unikając terminologii medycznej (nigdy nie używaj słowa "pathology").',
          '3. OCHRONA TERMINOLOGII IT: Zachowuj w oryginale akronimy i nazwy własne (np. XDR, PHP, Linux, Entra ID). Rozpoznawaj polskie końcówki deklinacyjne dołączone do skrótów (np. "MDM-ów" -> "MDMs", "XDR-ami" -> "XDRs") i konwertuj je na poprawną formę w języku docelowym.',
          '5. POLSKIE WYPEŁNIACZE I OTWARTA STRUKTURA: Ignoruj polskie wypełniacze ("no", "także", "jakby" traktuj jako pauzy myślowe lub pomijaj). Jeśli fragment uciął się w połowie, pozostaw otwartą strukturę gramatyczną – nie stawiaj kropki.'
        ]
      : [
          '2. ADAPTACJA SLANGU I KOREKTA ASR (IT CONTEXT): Jeśli transkrypcja zawiera błędy ze słyszenia w języku źródłowym (zniekształcone terminy IT, nazwy narzędzi lub marek), użyj logiki branżowej i [SŁOWNIK KONTEKSTOWY], aby odtworzyć właściwy sens przed tłumaczeniem. Nie tłumacz dosłownie absurdalnych błędów rozpoznawania mowy.',
          '3. OCHRONA TERMINOLOGII IT: Zachowuj w oryginale akronimy i nazwy własne (np. XDR, PHP, Linux, Entra ID, Azure, Intune, Defender) z poprawną odmianą w języku docelowym.',
          '5. WYPEŁNIACZE MOWY POTOCZNEJ I OTWARTA STRUKTURA: Pomijaj lub naturalnie redukuj typowe wypełniacze pauz myślowych w języku źródłowym (np. "also", "ähm", "euh", "bueno", "allora", "szóval", "you know"). Jeśli fragment uciął się w połowie, pozostaw otwartą strukturę gramatyczną – nie stawiaj kropki.'
        ];

    return [
      `Jesteś zaawansowanym tłumaczem symultanicznym działającym w aplikacji w czasie rzeczywistym. Otrzymujesz [KONTEKST] (poprzednie zdania) oraz tekst [DO PRZETŁUMACZENIA] z ${srcDesc}. Twoim zadaniem jest przetłumaczenie tekstu na naturalny, płynny język ${tgtInfo.namePl} (${tgtInfo.nameEn}).`,
      '',
      'DOMENA: Cyberbezpieczeństwo, Administracja Systemami (Linux, Windows), Cloud Computing (Azure), nowinki technologiczne oraz ogólna debata biznesowa.',
      '',
      'Bezwzględnie stosuj się do poniższych reguł:',
      `1. FILTR SZUMU (NOISE REDUCTION & ZERO TOLERANCE DLA POWTÓRZEŃ): Traktuj wszelkie jąkanie, zacięcia i powtórzenia słów lub całych fraz w tekście źródłowym jako BŁĄD SYSTEMU NASŁUCHOWEGO (szum). Twoim zadaniem jest bezwzględne odfiltrowanie tego szumu. NIGDY, pod żadnym pozorem, nie generuj powtórzeń w języku docelowym (${tgtInfo.namePl}). Redukuj też rozwlekłe emfazy do zwięzłej esencji przekazu.`,
      polishSpecificAsr[0],
      ...(isPolishSource ? polishSpecificAsr.slice(1, 7) : []),
      polishSpecificAsr[isPolishSource ? 7 : 1],
      '4. ROLA KONTEKSTU (SLIDING WINDOW): [KONTEKST] służy WYŁĄCZNIE do spójności gramatycznej, prawidłowego doboru zaimków i zrozumienia bieżącego wątku. Pod żadnym pozorem NIE tłumacz ponownie treści znajdujących się w [KONTEKŚCIE].',
      polishSpecificAsr[isPolishSource ? 8 : 2],
      '6. ZAKRES IT JEST TYLKO POMOCNICZY: Używaj logiki branży IT do korekty błędów ASR TYLKO wtedy, gdy słowo w transkrypcji ewidentnie nie ma sensu. Zwykłe potoczne słowa tłumacz normalnie. Nie wymyślaj na siłę terminów technicznych, gdy z kontekstu wynika luźna rozmowa.',
      speakerName ? `\nAKTUALNIE PRZEMAWIA: ${speakerName}` : '',
      config.debateTopic ? `\nTEMAT I KONTEKST DEBATY:\n${config.debateTopic.trim()}` : '',
      config.currentSlideContext ? `\n[AKTUALNY SLAJD PREZENTACJI] (terminologia i pojęcia widoczne teraz na ekranie — używaj do poprawy nazw własnych i akronimów):\n${config.currentSlideContext.trim()}` : '',
      config.glossary ? `\n[SŁOWNIK KONTEKSTOWY] (pojęcia, nazwiska, narzędzia — stosuj bezwzględnie):\n${config.glossary.trim()}` : '',
      contextLines ? `\n[KONTEKST] (poprzednie wypowiedzi — tylko do spójności, NIE tłumacz ich ponownie!):\n${contextLines}` : '',
      isAudio
        ? `\nOdpowiadaj wyłącznie poprawnym obiektem JSON o kluczach "pl" (transkrypcja źródłowa) oraz "en" (tłumaczenie na język ${tgtInfo.namePl}).`
        : `\nZwracaj wyłącznie sam przetłumaczony tekst w języku ${tgtInfo.namePl} (${tgtInfo.nameEn}), bez żadnych dodatkowych wyjaśnień.`
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * TRYB 3: Symulacja debaty na żywo (Demo)
   */
  startDemoMode() {
    let wordIndex = 0;
    let phase = 'typing'; // 'typing' | 'pause'
    let pauseTicks = 0;
    let demoSegmentId = 'demo-' + Date.now();

    this.demoTimer = setInterval(() => {
      if (!this.isRunning || this.isMuted) return;

      const currentSample = DEMO_SCRIPT[this.demoStepIndex % DEMO_SCRIPT.length];
      const plWords = currentSample.pl.split(' ');
      const enWords = currentSample.en.split(' ');

      const simulatedLevel = phase === 'typing' ? Math.floor(35 + Math.random() * 45) : Math.floor(Math.random() * 8);
      this.onAudioLevel?.(simulatedLevel);

      if (phase === 'typing') {
        wordIndex += 5;
        const progress = Math.min(1, wordIndex / enWords.length);
        const plSlice = plWords.slice(0, Math.max(2, Math.round(progress * plWords.length))).join(' ');
        const enSlice = enWords.slice(0, Math.min(enWords.length, wordIndex)).join(' ');

        this.onDraftUpdate?.({
          id: demoSegmentId,
          pl: plSlice,
          en: enSlice,
          speaker: currentSample.speaker
        });

        if (wordIndex >= enWords.length) {
          phase = 'pause';
          pauseTicks = 0;
        }
      } else {
        pauseTicks += 1;
        if (pauseTicks >= 2) {
          this.onFinalSegment?.({
            id: demoSegmentId,
            pl: currentSample.pl,
            en: currentSample.en,
            speaker: currentSample.speaker
          });
          this.demoStepIndex += 1;
          wordIndex = 0;
          phase = 'typing';
          demoSegmentId = 'demo-' + Date.now() + '-' + this.demoStepIndex;
        }
      }
    }, 1150);
  }
}

/**
 * Funkcje pomocnicze DSP dla bufora audio PCM 16kHz -> WAV Base64
 */
function downsampleBuffer(buffer, sampleRate, outSampleRate) {
  if (outSampleRate === sampleRate) {
    return new Float32Array(buffer);
  }
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function pcmRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  const step = 4;
  for (let i = 0; i < samples.length; i += step) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.ceil(samples.length / step));
}

function mergeFloat32Arrays(arrays) {
  let totalLen = 0;
  for (const arr of arrays) totalLen += arr.length;
  const result = new Float32Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeWAVBase64(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
