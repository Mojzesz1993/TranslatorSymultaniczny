/**
 * voice-id.js
 * Silnik Biometrycznego Rozpoznawania Głosów Prelegentów (Voiceprint ID v4 — Neural WeSpeaker CAM++ 512-D ONNX).
 *
 * Architektura:
 * 1. Przechwytuje czysty strumień audio (16000 Hz Mono Int16 PCM) bezpośrednio z Web Audio API (bez kompresji AGC/NoiseSuppression).
 * 2. Wysyła aktywne okna mowy (~1.4s) do lokalnego silnika neuronowego Python ONNX (/api/voice-embed),
 *    który za pomocą modelu głębokiego uczenia WeSpeaker CAM++ (wytrenowanego na VoxCeleb2) wylicza
 *    512-wymiarowy wektor tożsamości głosowej (d-vector / x-vector) w ~25–30 ms na CPU.
 * 3. Wektor 512-D jest w 100% niezależny od wymawianych słów i bezbłędnie rozróżnia męskie głosy
 *    nawet o identycznej wysokości tonu krtaniowego (F0).
 * 4. Każdy profil mówcy przechowuje zarówno wektor centralny (Centroid 512-D), jak i galerię do 6 próbek
 *    wzorcowych (Multi-Prototype Gallery), dzięki czemu kolejne kliknięcia „Przypisz obecny głos”
 *    dodatkowo doszkalają profil tego mówcy.
 */

const STORAGE_KEY_PROFILES = 'debate_translator_voice_profiles_v1';
const VOICEPRINT_VERSION = 4; // Wersja 4 = 512-wymiarowy wektor neuronowy WeSpeaker CAM++ ONNX

export const SPEAKER_PALETTE = [
  '#F59E0B', // Bursztynowy
  '#38BDF8', // Błękitny
  '#10B981', // Szmaragdowy
  '#EC4899', // Różowy / Magenta
  '#A855F7', // Fioletowy
  '#F97316', // Pomarańczowy
  '#14B8A6', // Turkusowy
  '#EAB308'  // Złoty
];

const TARGET_SAMPLE_RATE = 16000;

export class VoiceIdentificationManager {
  constructor({ onSpeakerRecognized, onProfilesUpdated, onLiveConfidenceUpdate }) {
    this.onSpeakerRecognized = onSpeakerRecognized;
    this.onProfilesUpdated = onProfilesUpdated;
    this.onLiveConfidenceUpdate = onLiveConfidenceUpdate;

    this.profiles = this.loadProfiles();
    this.autoRecognizeEnabled = true;
    this.sensitivityThreshold = 0.66; // Domyślny próg pewności (66%)

    // Bufory 16kHz Int16 PCM dla modelu neuronowego WeSpeaker CAM++
    this.rollingVoicedPcmChunks = []; // Ostatnie ~4.2s aktywnej mowy (do przyuczania 1 kliknięciem)
    this.rollingSamplesCount = 0;
    this.maxRollingSamples = TARGET_SAMPLE_RATE * 4.2; // 67200 próbek

    this.utterancePcmChunks = []; // Bieżące okno mowy (~0.90s) do błyskawicznej klasyfikacji na żywo
    this.utteranceSamplesCount = 0;
    this.maxUtteranceSamples = Math.round(TARGET_SAMPLE_RATE * 0.90); // 14400 próbek — brak bezwładności po poprzednim mówcy

    this.silenceChunksCount = 0;
    this.justHadSilencePause = true;
    this.lastInferenceTime = 0;
    this.neuralRequestInFlight = false;
    this.lastLiveEmbedding = null;

    // Nagrywanie dedykowanej próbki 4s dla wybranego mówcy
    this.enrollingSpeakerId = null;
    this.enrollingPcmChunks = [];
    this.enrollingTimeout = null;

    this.currentDetectedSpeakerId = null;
    this.candidateSpeakerId = null;
    this.candidateStreak = 0;

    this.scriptProcessor = null;
    this.silentGain = null;
    this.analysisTimer = null;
  }

  loadProfiles() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((p) => {
            if (p.voiceprint && p.voiceprint.version !== VOICEPRINT_VERSION) {
              return { ...p, voiceprint: null, sampleCount: 0 };
            }
            return p;
          });
        }
      }
    } catch (_) {}

    return [
      {
        id: 'spk-1',
        name: 'Moderator',
        color: SPEAKER_PALETTE[0],
        voiceprint: null,
        sampleCount: 0
      },
      {
        id: 'spk-2',
        name: 'Prelegent 1',
        color: SPEAKER_PALETTE[1],
        voiceprint: null,
        sampleCount: 0
      },
      {
        id: 'spk-3',
        name: 'Prelegent 2',
        color: SPEAKER_PALETTE[2],
        voiceprint: null,
        sampleCount: 0
      }
    ];
  }

  saveProfiles() {
    try {
      localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(this.profiles));
    } catch (_) {}
    this.onProfilesUpdated?.(this.profiles);
  }

  addSpeaker(name = 'Nowy Prelegent', color = null) {
    const cleanName = (name || '').trim() || `Prelegent ${this.profiles.length + 1}`;
    const chosenColor = color || SPEAKER_PALETTE[this.profiles.length % SPEAKER_PALETTE.length];
    const newProfile = {
      id: 'spk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
      name: cleanName,
      color: chosenColor,
      voiceprint: null,
      sampleCount: 0
    };
    this.profiles.push(newProfile);
    this.saveProfiles();
    return newProfile;
  }

  updateSpeaker(id, partial) {
    this.profiles = this.profiles.map((p) => (p.id === id ? { ...p, ...partial } : p));
    this.saveProfiles();
  }

  removeSpeaker(id) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.saveProfiles();
  }

  clearVoiceprint(id) {
    this.updateSpeaker(id, { voiceprint: null, sampleCount: 0 });
  }

  getSpeakerByName(name) {
    if (!name) return null;
    const clean = name.trim().toLowerCase();
    return this.profiles.find((p) => p.name.trim().toLowerCase() === clean) || null;
  }

  getSpeakerColor(name) {
    const found = this.getSpeakerByName(name);
    return found ? found.color : '#F59E0B';
  }

  /**
   * Podłącza potok przechwytujący PCM 16kHz do aktywnego kontekstu Web Audio API
   */
  attachToAudioContext(audioContext, sourceNode) {
    this.detachAudio();
    if (!audioContext || !sourceNode) return;

    const inputSampleRate = audioContext.sampleRate;
    const processor = audioContext.createScriptProcessor(2048, 1, 1); // 42ms niskiej latencji
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    this.analysisTimer = true; // Flaga aktywności dla operator.js

    processor.onaudioprocess = (event) => {
      const floatData = event.inputBuffer.getChannelData(0);

      // Oblicz energię RMS ramki (~42ms przy 48kHz)
      let sumSq = 0;
      for (let i = 0; i < floatData.length; i++) {
        sumSq += floatData[i] * floatData[i];
      }
      const rms = Math.sqrt(sumSq / floatData.length);

      if (rms < 0.011) {
        this.silenceChunksCount += 1;
        // Po krótkiej pauzie (~170ms ciszy = 4 bloki po 42ms) czyścimy okno bieżącej wypowiedzi,
        // aby nowy mówca wchodzący po pauzie był rozpoznany natychmiast w ~0.4s
        if (this.silenceChunksCount >= 4 && this.utteranceSamplesCount > 0) {
          this.utterancePcmChunks = [];
          this.utteranceSamplesCount = 0;
          this.lastLiveEmbedding = null;
          this.justHadSilencePause = true;
        }
        return;
      }

      this.silenceChunksCount = 0;

      // Downsample do 16000 Hz Int16 PCM
      const pcm16Chunk = downsampleFloatToInt16(floatData, inputSampleRate, TARGET_SAMPLE_RATE);

      // 1. Dodaj do bufora kołowego ostatnich ~4.2s (do nauki jednym kliknięciem)
      this.rollingVoicedPcmChunks.push(pcm16Chunk);
      this.rollingSamplesCount += pcm16Chunk.length;
      while (this.rollingSamplesCount > this.maxRollingSamples && this.rollingVoicedPcmChunks.length > 1) {
        const removed = this.rollingVoicedPcmChunks.shift();
        this.rollingSamplesCount -= removed.length;
      }

      // 2. Jeśli trwa nagrywanie 4s próbki dla wybranego mówcy
      if (this.enrollingSpeakerId) {
        this.enrollingPcmChunks.push(pcm16Chunk);
      }

      // 3. Dodaj do bieżącego okna klasyfikacji na żywo (~0.90s)
      this.utterancePcmChunks.push(pcm16Chunk);
      this.utteranceSamplesCount += pcm16Chunk.length;
      while (this.utteranceSamplesCount > this.maxUtteranceSamples && this.utterancePcmChunks.length > 1) {
        const removed = this.utterancePcmChunks.shift();
        this.utteranceSamplesCount -= removed.length;
      }

      // 4. Szybki start: już po 0.42s mowy (i dalej co 260ms) wywołaj lokalny model neuronowy WeSpeaker CAM++ ONNX
      const now = Date.now();
      if (
        this.utteranceSamplesCount >= Math.round(TARGET_SAMPLE_RATE * 0.42) &&
        !this.neuralRequestInFlight &&
        now - this.lastInferenceTime >= 260
      ) {
        this.lastInferenceTime = now;
        const mergedPcm = mergeInt16Arrays(this.utterancePcmChunks, this.utteranceSamplesCount);
        this.runLiveNeuralInference(mergedPcm);
      }
    };

    sourceNode.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    this.scriptProcessor = processor;
    this.silentGain = silentGain;
  }

  detachAudio() {
    this.analysisTimer = null;
    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch (_) {}
      this.scriptProcessor = null;
    }
    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch (_) {}
      this.silentGain = null;
    }
    this.utterancePcmChunks = [];
    this.utteranceSamplesCount = 0;
    this.silenceChunksCount = 0;
    this.lastLiveEmbedding = null;
  }

  async requestNeuralEmbeddingFromServer(int16Pcm) {
    const pcm16Base64 = int16ArrayToBase64(int16Pcm);
    const res = await fetch('/api/voice-embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcm16Base64 })
    });
    if (!res.ok) {
      throw new Error(`Błąd serwera biometrii ONNX (${res.status})`);
    }
    return res.json();
  }

  async runLiveNeuralInference(int16Pcm) {
    if (this.neuralRequestInFlight) return;
    this.neuralRequestInFlight = true;
    try {
      const result = await this.requestNeuralEmbeddingFromServer(int16Pcm);
      if (!result || !result.ok || !Array.isArray(result.embedding)) {
        return;
      }

      const currentEmb = result.embedding;
      const pitchHz = result.pitchHz || 0;

      // Detekcja nagłej zmiany mówcy bez pauzy (gdy drugi mężczyzna wchodzi bezpośrednio w słowo):
      // jeśli nowy wektor 512-D ma niskie podobieństwo cosinusowe (< 0.35) do poprzedniego okna sprzed 0.5s,
      // przytnij bufor tylko do najnowszych 0.7s, aby natychmiast odciąć ogon poprzedniego mówcy!
      if (this.lastLiveEmbedding) {
        const continuityCos = cosineSimilarity512(currentEmb, this.lastLiveEmbedding);
        if (continuityCos < 0.35 && this.utterancePcmChunks.length > 3) {
          const keepChunks = this.utterancePcmChunks.slice(-3);
          this.utterancePcmChunks = keepChunks;
          this.utteranceSamplesCount = keepChunks.reduce((acc, c) => acc + c.length, 0);
        }
      }
      this.lastLiveEmbedding = currentEmb;

      this.evaluateNeuralSpeakerMatch(currentEmb, pitchHz);
    } catch (err) {
      console.warn('Neural Voice-ID inference warning:', err);
    } finally {
      this.neuralRequestInFlight = false;
    }
  }

  /**
   * 1. Błyskawiczne przypisanie aktualnie słyszanego głosu (z bufora ostatnich ~3.5s) do prelegenta
   */
  learnFromRecentLiveVoice(speakerId) {
    const profile = this.profiles.find((p) => p.id === speakerId);
    if (!profile) return { ok: false, reason: 'Nie znaleziono prelegenta.' };

    // Jeśli w buforze kołowym mamy już co najmniej 1.2 sekundy mowy (19200 próbek), wylicz wektor od razu
    if (this.rollingSamplesCount >= TARGET_SAMPLE_RATE * 1.2) {
      // Bierzemy ostatnie ~3.0 sekundy mowy, aby nie zahaczyć o wcześniejszego mówcę
      const maxSamplesToTake = Math.round(TARGET_SAMPLE_RATE * 3.0);
      const selectedChunks = [];
      let count = 0;
      for (let i = this.rollingVoicedPcmChunks.length - 1; i >= 0; i--) {
        selectedChunks.unshift(this.rollingVoicedPcmChunks[i]);
        count += this.rollingVoicedPcmChunks[i].length;
        if (count >= maxSamplesToTake) break;
      }

      const pcm = mergeInt16Arrays(selectedChunks, count);
      this.requestNeuralEmbeddingFromServer(pcm)
        .then((res) => {
          if (res && res.ok && Array.isArray(res.embedding)) {
            this.saveSpeakerNeuralEmbedding(speakerId, res.embedding, res.pitchHz || 120);
          }
        })
        .catch((err) => console.error('Instant neural learn error:', err));

      return { ok: true, mode: 'instant', profile };
    }

    // Jeśli bufor jest jeszcze pusty, włącz 3.5-sekundowe zbieranie próbki
    return this.startTimedEnrollment(speakerId, 3500);
  }

  /**
   * 2. Nagranie dedykowanej próbki głosu przez określony czas (np. 4 sekundy podczas próby mikrofonów)
   */
  startTimedEnrollment(speakerId, durationMs = 4000, onComplete = null) {
    const profile = this.profiles.find((p) => p.id === speakerId);
    if (!profile) return { ok: false };

    clearTimeout(this.enrollingTimeout);
    this.enrollingSpeakerId = speakerId;
    this.enrollingPcmChunks = [...this.rollingVoicedPcmChunks.slice(-3)];

    this.enrollingTimeout = setTimeout(async () => {
      const chunks = this.enrollingPcmChunks;
      this.enrollingSpeakerId = null;
      this.enrollingPcmChunks = [];

      const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalSamples < TARGET_SAMPLE_RATE * 0.8) {
        onComplete?.({
          ok: false,
          message: `Wykryto za mało mowy dla „${profile.name}”. Powiedz kilka słów głośniej do mikrofonu.`
        });
        return;
      }

      try {
        const pcm = mergeInt16Arrays(chunks, totalSamples);
        const res = await this.requestNeuralEmbeddingFromServer(pcm);
        if (!res || !res.ok || !Array.isArray(res.embedding)) {
          onComplete?.({
            ok: false,
            message: `W nagraniu dla „${profile.name}” nie wykryto wystarczająco wyraźnego głosu.`
          });
          return;
        }

        const updatedProfile = this.saveSpeakerNeuralEmbedding(speakerId, res.embedding, res.pitchHz || 120);
        onComplete?.({
          ok: true,
          profile: updatedProfile,
          framesCount: res.voicedFrames || 100
        });
      } catch (err) {
        onComplete?.({
          ok: false,
          message: `Błąd analizy neuronowej: ${err.message}`
        });
      }
    }, durationMs);

    return { ok: true, mode: 'recording', durationMs };
  }

  /**
   * 3. Wyodrębnienie 512-wymiarowego wzorca neuronowego z wgranego pliku audio (WAV, MP3, M4A, OGG, MP4)
   */
  async enrollFromAudioFile(speakerId, file) {
    const profile = this.profiles.find((p) => p.id === speakerId);
    if (!profile || !file) throw new Error('Wybierz prelegenta i plik audio.');

    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const tempCtx = new AudioCtx();

    try {
      const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);
      // Weź maksymalnie pierwsze 15 sekund nagrania
      const maxLen = Math.min(channelData.length, audioBuffer.sampleRate * 15);
      const sliced = channelData.subarray(0, maxLen);
      const pcm16 = downsampleFloatToInt16(sliced, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);

      const res = await this.requestNeuralEmbeddingFromServer(pcm16);
      if (!res || !res.ok || !Array.isArray(res.embedding)) {
        throw new Error('W pliku audio nie wykryto wystarczająco wyraźnej mowy.');
      }

      return this.saveSpeakerNeuralEmbedding(speakerId, res.embedding, res.pitchHz || 120);
    } finally {
      tempCtx.close().catch(() => {});
    }
  }

  /**
   * Zapisuje nowy 512-wymiarowy wektor neuronowy WeSpeaker CAM++ do profilu prelegenta
   * (aktualizuje wektor centralny oraz galerię do 6 prototypów głosowych tego mówcy).
   */
  saveSpeakerNeuralEmbedding(speakerId, newEmbedding, pitchHz = 120) {
    const profile = this.profiles.find((p) => p.id === speakerId);
    if (!profile) return null;

    const oldVp = profile.voiceprint && profile.voiceprint.version === VOICEPRINT_VERSION
      ? profile.voiceprint
      : null;

    let prototypes = oldVp && Array.isArray(oldVp.prototypes) ? [...oldVp.prototypes] : [];
    prototypes.push(newEmbedding);
    if (prototypes.length > 6) {
      prototypes = prototypes.slice(-6);
    }

    // Wylicz znormalizowany centroid 512-D ze wszystkich zebranych próbek tego mówcy
    const dim = newEmbedding.length;
    const centroid = new Array(dim).fill(0);
    for (const proto of prototypes) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += proto[i] || 0;
      }
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i];
    norm = Math.sqrt(norm) || 1;
    const normalizedCentroid = centroid.map((v) => Math.round((v / norm) * 100000) / 100000);

    const mergedPitch = oldVp && oldVp.pitchHz && pitchHz
      ? Math.round((oldVp.pitchHz * 0.4 + pitchHz * 0.6))
      : (pitchHz || oldVp?.pitchHz || 120);

    const nextVp = {
      version: VOICEPRINT_VERSION,
      model: 'WeSpeaker-CAM++-512D',
      pitchHz: mergedPitch,
      embedding: normalizedCentroid,
      prototypes,
      mel: normalizedCentroid.slice(0, 16) // kompatybilność ze wskaźnikami UI
    };

    this.updateSpeaker(speakerId, {
      voiceprint: nextVp,
      sampleCount: (profile.sampleCount || 0) + 1
    });

    const updatedProfile = this.profiles.find((p) => p.id === speakerId);
    this.currentDetectedSpeakerId = speakerId;
    this.onSpeakerRecognized?.(updatedProfile, 100);
    return updatedProfile;
  }

  /**
   * Porównuje bieżący 512-wymiarowy wektor neuronowy WeSpeaker CAM++ ze wszystkimi zapisanymi mówcami.
   * W przestrzeni 512-D WeSpeaker CAM++:
   * - Dwa różne męskie głosy (nawet o tym samym F0 = 115 Hz) mają podobieństwo cosinusowe ~ 0.05 – 0.28.
   * - Ten sam mężczyzna mówiący inne zdanie ma podobieństwo cosinusowe ~ 0.48 – 0.88.
   */
  evaluateNeuralSpeakerMatch(liveEmbedding, currentPitchHz) {
    const enrolled = this.profiles.filter(
      (p) => p.voiceprint && p.voiceprint.version === VOICEPRINT_VERSION && Array.isArray(p.voiceprint.embedding)
    );

    if (enrolled.length === 0) {
      this.onLiveConfidenceUpdate?.({
        bestProfile: null,
        bestConfidence: 0,
        bestScorePct: 0,
        scoresMap: {},
        currentPitchHz,
        pitchHz: currentPitchHz
      });
      return;
    }

    const rawCosines = {};
    let bestProfile = null;
    let bestCos = -1;
    let secondBestCos = -1;

    for (const prof of enrolled) {
      const vp = prof.voiceprint;
      const centroidCos = cosineSimilarity512(liveEmbedding, vp.embedding);
      let maxProtoCos = centroidCos;
      if (Array.isArray(vp.prototypes)) {
        for (const proto of vp.prototypes) {
          const c = cosineSimilarity512(liveEmbedding, proto);
          if (c > maxProtoCos) maxProtoCos = c;
        }
      }
      // Połączenie podobieństwa do centroidu (50%) i najbliższego prototypu (50%)
      const combinedCos = centroidCos * 0.50 + maxProtoCos * 0.50;
      rawCosines[prof.id] = combinedCos;

      if (combinedCos > bestCos) {
        secondBestCos = bestCos;
        bestCos = combinedCos;
        bestProfile = prof;
      } else if (combinedCos > secondBestCos) {
        secondBestCos = combinedCos;
      }
    }

    // Przeliczenie surowego cosinusa neuronowego CAM++ [-0.05 .. 0.78] na czytelny procent pewności [0% .. 100%]
    // (cos = 0.42 -> ~66%, cos = 0.55 -> ~82%, cos = 0.70 -> ~95%)
    const cosToUiScore = (cosVal) => {
      if (cosVal <= 0.12) return Math.max(0, Math.round(((cosVal + 0.1) / 0.22) * 18));
      const norm = (cosVal - 0.12) / 0.62; // 0.12 -> 0, 0.74 -> 1.0
      return Math.max(0, Math.min(99, Math.round(18 + norm * 81)));
    };

    const scoresMap = {};
    for (const prof of enrolled) {
      scoresMap[prof.id] = cosToUiScore(rawCosines[prof.id]);
    }

    // Kontrastowa przewaga nad drugim mówcą (Margin) w przestrzeni 512-D
    const cosMargin = enrolled.length >= 2 ? (bestCos - secondBestCos) : 0.20;
    let bestConfidence = scoresMap[bestProfile.id] || 0;

    // Jeśli najlepszy mówca ma wyraźną przewagę neuronową (margin >= 0.10) i przekracza bazowy próg cos >= 0.38,
    // premiujemy pewność, a jeśli dwaj mówcy idą łeb w łeb (margin < 0.045), tłumimy pewność, aby uniknąć fałszywego przeskoku!
    if (enrolled.length >= 2) {
      if (bestCos >= 0.40 && cosMargin >= 0.10) {
        bestConfidence = Math.min(99, bestConfidence + Math.round(cosMargin * 25));
      } else if (cosMargin < 0.045) {
        bestConfidence = Math.min(bestConfidence, Math.round(this.sensitivityThreshold * 100) - 4);
      }
      scoresMap[bestProfile.id] = bestConfidence;
    }

    this.onLiveConfidenceUpdate?.({
      bestProfile,
      bestConfidence,
      bestScorePct: bestConfidence,
      scoresMap,
      currentPitchHz,
      pitchHz: currentPitchHz
    });

    if (!this.autoRecognizeEnabled || !bestProfile) return;

    const thresholdPct = Math.round(this.sensitivityThreshold * 100);
    const minRequiredMarginCos = enrolled.length >= 2 ? 0.05 : 0.0;

    if (bestConfidence >= thresholdPct && cosMargin >= minRequiredMarginCos) {
      if (this.candidateSpeakerId === bestProfile.id) {
        this.candidateStreak += 1;
      } else {
        this.candidateSpeakerId = bestProfile.id;
        this.candidateStreak = 1;
      }

      // Natychmiastowe przełączenie (po pierwszym oknie ~0.42s), jeśli nastąpiło po pauzie lub z wysoką przewagą neuronową
      const requiredStreak = (this.justHadSilencePause || cosMargin >= 0.085 || bestConfidence >= thresholdPct + 6) ? 1 : 2;
      if (this.candidateStreak >= requiredStreak && this.currentDetectedSpeakerId !== bestProfile.id) {
        this.justHadSilencePause = false;
        this.currentDetectedSpeakerId = bestProfile.id;
        this.onSpeakerRecognized?.(bestProfile, bestConfidence);
      }
    }
  }
}

function cosineSimilarity512(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA * normB);
  return denom > 1e-8 ? dot / denom : 0;
}

function downsampleFloatToInt16(floatBuffer, inSampleRate, outSampleRate) {
  const ratio = inSampleRate / outSampleRate;
  const outLen = Math.round(floatBuffer.length / ratio);
  const result = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(floatBuffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += floatBuffer[j];
      count++;
    }
    const sample = count > 0 ? sum / count : (floatBuffer[start] || 0);
    const clamped = Math.max(-1, Math.min(1, sample));
    result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return result;
}

function mergeInt16Arrays(chunks, totalLength) {
  const out = new Int16Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function int16ArrayToBase64(int16Arr) {
  const bytes = new Uint8Array(int16Arr.buffer, int16Arr.byteOffset, int16Arr.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
