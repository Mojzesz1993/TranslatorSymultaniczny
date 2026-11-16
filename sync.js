/**
 * sync.js
 * Wspólny moduł stanu, synchronizacji między oknami (Operator <-> Ekran Prezentacji)
 * oraz trwałego przechowywania tła (IndexedDB + BroadcastChannel + Serwer Lokalny).
 */

const STORAGE_KEY_SETTINGS = 'debate_translator_settings_v1';
const STORAGE_KEY_STATE = 'debate_translator_live_state_v1';
const STORAGE_KEY_API = 'debate_translator_api_config_v1';
const CHANNEL_NAME = 'debate_translator_channel_v1';
const IDB_NAME = 'DebateTranslatorMediaDB';
const IDB_STORE = 'backgrounds';

export const DEFAULT_SETTINGS = {
  // Układ i tryb wyświetlania
  displayMode: 'teleprompter', // 'teleprompter' | 'single-center' | 'lower-third'
  maxVisibleItems: 3,          // Ile ostatnich wypowiedzi widać w trybie Teleprompter (1-6)
  historyOpacity: 0.48,        // Przezroczystość starszych zdań (0.15 - 0.9)
  historyScale: 0.82,          // Skala starszych zdań względem aktualnego (0.6 - 1.0)
  showPolishOriginal: false,   // Czy pokazywać też mały polski oryginał na ekranie głównym
  showLiveDraft: false,        // Wyświetlaj wyłącznie gotowe, pełne tłumaczenia bez szkiców pośrednich (Live Draft wyłączony)
  noDraftsMigrated: true,
  showSpeakerBadge: true,      // Czy wyświetlać podpis aktualnego mówcy (jeśli wybrany)

  // Typografia (Wyraźne, duże litery)
  fontFamily: "'Montserrat', 'Segoe UI', system-ui, sans-serif",
  fontSizePx: 64,              // Rozmiar głównego tekstu EN (28 - 130 px)
  fontWeight: '800',           // 600, 700, 800, 900
  lineHeight: 1.24,
  letterSpacing: 0,            // px
  textAlign: 'left',           // 'left' (stabilny początek wiersza) | 'center'
  uppercaseText: false,        // Wielkie litery (ALL CAPS)

  // Kolory i kontrast liter
  textColor: '#FFFFFF',
  draftTextColor: '#BAE6FD',   // Lekko błękitny/jasny kolor dla tekstu w trakcie mówienia (lub taki sam jak główny)
  plTextColor: '#94A3B8',      // Kolor polskiego oryginału (gdy włączony)
  speakerBadgeColor: '#F59E0B',
  textShadowPreset: 'strong-outline', // 'none' | 'soft' | 'strong-drop' | 'strong-outline' | 'neon-glow'
  textStrokePx: 2,             // Grubość czarnego obrysu liter (0 - 6 px)

  // Boks pod tekstem (dodatkowe tło bezpośrednio pod napisami)
  textBoxEnabled: false,
  textBoxColor: '#000000',
  textBoxOpacity: 0.65,
  textBoxBlurPx: 10,
  textBoxRadiusPx: 18,
  textBoxPaddingPx: 28,

  // Tło ekranu prezentacji
  bgType: 'gradient',          // 'color' | 'gradient' | 'image' | 'video' | 'chroma'
  bgColor: '#090D16',
  bgGradient: 'linear-gradient(135deg, #060B19 0%, #0F172A 50%, #1E1B4B 100%)',
  bgChromaColor: '#00FF00',
  bgFit: 'cover',              // 'cover' | 'contain' | 'fill'
  bgPosition: 'center center',
  bgDimOpacity: 0.35,          // Przyciemnienie nałożone na grafikę/wideo tła (0.0 - 0.95)
  bgBlurPx: 0,                 // Rozmycie grafiki tła (0 - 30 px)

  // Marginesy bezpieczne (Safe Area - żeby nie zasłaniać logotypów na tle)
  marginTopPct: 8,
  marginBottomPct: 8,
  marginLeftPct: 7,
  marginRightPct: 7
};

export const DEFAULT_LIVE_STATE = {
  isListening: false,
  isMuted: false,
  blackout: false,             // Ukrywa cały tekst, zostawiając samo tło
  activeSpeaker: '',           // np. "Jan Kowalski — Prezes Zarządu"
  speakerColors: {
    'Moderator': '#F59E0B',
    'Prelegent 1': '#38BDF8',
    'Prelegent 2': '#10B981'
  },
  customBanner: {
    active: false,
    title: '',
    subtitle: ''
  },
  liveDraft: {
    id: null,
    pl: '',
    en: '',
    speaker: '',
    updatedAt: 0
  },
  items: [
    {
      id: 'welcome-sample-1',
      timestamp: '12:00:00',
      speaker: 'Moderator',
      pl: 'Witamy serdecznie wszystkich uczestników naszej dzisiejszej debaty.',
      en: 'A warm welcome to all participants joining our debate today.',
      isFinal: true
    }
  ]
};

export const SUPPORTED_LANGUAGES = [
  { code: 'pl', bcp47: 'pl-PL', namePl: 'Polski', nameEn: 'Polish' },
  { code: 'en', bcp47: 'en-US', namePl: 'Angielski', nameEn: 'English' },
  { code: 'de', bcp47: 'de-DE', namePl: 'Niemiecki', nameEn: 'German' },
  { code: 'es', bcp47: 'es-ES', namePl: 'Hiszpański', nameEn: 'Spanish' },
  { code: 'it', bcp47: 'it-IT', namePl: 'Włoski', nameEn: 'Italian' },
  { code: 'hu', bcp47: 'hu-HU', namePl: 'Węgierski', nameEn: 'Hungarian' },
  { code: 'fr', bcp47: 'fr-FR', namePl: 'Francuski', nameEn: 'French' },
  { code: 'uk', bcp47: 'uk-UA', namePl: 'Ukraiński', nameEn: 'Ukrainian' },
  { code: 'cs', bcp47: 'cs-CZ', namePl: 'Czeski', nameEn: 'Czech' },
  { code: 'sk', bcp47: 'sk-SK', namePl: 'Słowacki', nameEn: 'Slovak' },
  { code: 'pt', bcp47: 'pt-PT', namePl: 'Portugalski', nameEn: 'Portuguese' },
  { code: 'nl', bcp47: 'nl-NL', namePl: 'Niderlandzki', nameEn: 'Dutch' },
  { code: 'ro', bcp47: 'ro-RO', namePl: 'Rumuński', nameEn: 'Romanian' },
  { code: 'sv', bcp47: 'sv-SE', namePl: 'Szwedzki', nameEn: 'Swedish' },
  { code: 'nb', bcp47: 'nb-NO', namePl: 'Norweski', nameEn: 'Norwegian' },
  { code: 'da', bcp47: 'da-DK', namePl: 'Duński', nameEn: 'Danish' },
  { code: 'fi', bcp47: 'fi-FI', namePl: 'Fiński', nameEn: 'Finnish' },
  { code: 'hr', bcp47: 'hr-HR', namePl: 'Chorwacki', nameEn: 'Croatian' },
  { code: 'bg', bcp47: 'bg-BG', namePl: 'Bułgarski', nameEn: 'Bulgarian' },
  { code: 'el', bcp47: 'el-GR', namePl: 'Grecki', nameEn: 'Greek' },
  { code: 'tr', bcp47: 'tr-TR', namePl: 'Turecki', nameEn: 'Turkish' },
  { code: 'ja', bcp47: 'ja-JP', namePl: 'Japoński', nameEn: 'Japanese' },
  { code: 'ko', bcp47: 'ko-KR', namePl: 'Koreański', nameEn: 'Korean' },
  { code: 'zh', bcp47: 'zh-CN', namePl: 'Chiński (Mandaryński)', nameEn: 'Chinese (Mandarin)' }
];

export function getLanguageInfo(code) {
  if (code === 'auto') {
    return { code: 'auto', bcp47: 'pl-PL', namePl: 'Auto-wykrywanie (Direct Audio)', nameEn: 'Auto-detected spoken language' };
  }
  return SUPPORTED_LANGUAGES.find((l) => l.code === code) || SUPPORTED_LANGUAGES[0];
}

export const DEFAULT_API_CONFIG = {
  geminiApiKey: '',
  sourceLang: 'pl',
  targetLang: 'en',
  engineMode: 'hybrid', // 'hybrid' (Web Speech + Gemini Flash) | 'gemini-audio' (Direct Audio -> Gemini) | 'demo'
  geminiModel: 'gemini-flash-latest',
  audioDeviceId: 'default',
  draftIntervalMs: 2000,       // Jak często tłumaczyć Live Draft w trakcie długiego zdania
  vadSilenceMs: 1400,          // Po jakim czasie ciszy zamykać zdanie w trybie Direct Audio
  debateTopic: 'Debata ekspercka na żywo (Polska -> Angielski). Ton profesjonalny, klarowny, konferencyjny.',
  glossary: 'KPO = National Recovery Plan (KPO)\nAI = Artificial Intelligence (AI)\nUE = European Union (EU)',
  speakersList: [
    'Moderator',
    'Prelegent 1',
    'Prelegent 2'
  ]
};

/**
 * Pomocnik IndexedDB do zapisu dużych plików tła (grafika 4K / wideo MP4)
 */
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBackgroundMedia(dataUrl, mediaType, fileName) {
  try {
    const db = await openMediaDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ dataUrl, mediaType, fileName, updatedAt: Date.now() }, 'current_bg');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB save warning:', err);
  }

  // Wyślij też na lokalny serwer Pythona (jeśli działa), aby inne przeglądarki miały dostęp
  try {
    await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, mediaType, fileName })
    });
  } catch (_) {
    // Ignoruj gdy otwarto z file:// bez serwera
  }
}

export async function loadBackgroundMedia() {
  try {
    const db = await openMediaDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('current_bg');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (record && record.dataUrl) {
      return record;
    }
  } catch (err) {
    console.warn('IndexedDB load warning:', err);
  }

  // Fallback do serwera lokalnego
  try {
    const res = await fetch('/api/background');
    if (res.ok) {
      const data = await res.json();
      if (data && data.dataUrl) {
        return data;
      }
    }
  } catch (_) {}

  return null;
}

export async function clearBackgroundMedia() {
  try {
    const db = await openMediaDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete('current_bg');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}

  try {
    await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: null, mediaType: null, fileName: null })
    });
  } catch (_) {}
}

/**
 * Klasa zarządzająca synchronizacją stanu pomiędzy Panelem Operatora a Ekranem Prezentacji
 */
export class SyncManager {
  constructor(role = 'operator') {
    this.role = role; // 'operator' | 'screen'
    this.settings = this.loadSettings();
    this.liveState = this.loadLiveState();
    this.apiConfig = this.loadApiConfig();
    this.listeners = new Set();
    this.bgListeners = new Set();
    this.lastServerVersion = 0;

    // 1. BroadcastChannel (natychmiastowa komunikacja <1ms między oknami tej samej przeglądarki)
    this.channel = null;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event) => this.handleIncomingMessage(event.data);
    }

    // 2. Zdarzenie storage (fallback dla kart w tej samej przeglądarki)
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY_SETTINGS && event.newValue) {
        try {
          this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(event.newValue) };
          this.notifyListeners('settings');
        } catch (_) {}
      } else if (event.key === STORAGE_KEY_STATE && event.newValue) {
        try {
          this.liveState = { ...DEFAULT_LIVE_STATE, ...JSON.parse(event.newValue) };
          this.notifyListeners('liveState');
        } catch (_) {}
      }
    });

    // 3. Jeśli jesteśmy Ekranem Prezentacji, odpytujemy też lekki endpoint lokalnego serwera
    //    (pozwala otworzyć ekran w innym profilu przeglądarki lub na drugim komputerze w LAN)
    if (this.role === 'screen') {
      this.startServerPolling();
    }
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.noDraftsMigrated) {
          parsed.showLiveDraft = false;
          parsed.noDraftsMigrated = true;
          localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(parsed));
        }
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  }

  loadLiveState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_STATE);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_LIVE_STATE,
          ...parsed,
          customBanner: { ...DEFAULT_LIVE_STATE.customBanner, ...(parsed.customBanner || {}) },
          liveDraft: { ...DEFAULT_LIVE_STATE.liveDraft, ...(parsed.liveDraft || {}) },
          items: Array.isArray(parsed.items) ? parsed.items : DEFAULT_LIVE_STATE.items
        };
      }
    } catch (_) {}
    return structuredClone(DEFAULT_LIVE_STATE);
  }

  loadApiConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_API);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.geminiModel === 'gemini-2.5-flash' || parsed.geminiModel === 'gemini-2.0-flash') {
          parsed.geminiModel = 'gemini-flash-latest';
        }
        return { ...DEFAULT_API_CONFIG, ...parsed };
      }
    } catch (_) {}
    return { ...DEFAULT_API_CONFIG };
  }

  saveApiConfig(partial) {
    this.apiConfig = { ...this.apiConfig, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY_API, JSON.stringify(this.apiConfig));
    } catch (_) {}
    return this.apiConfig;
  }

  updateSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(this.settings));
    } catch (_) {}
    this.broadcast({
      type: 'SYNC_UPDATE',
      settings: this.settings,
      liveState: this.liveState
    });
    this.notifyListeners('settings');
  }

  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(this.settings));
    } catch (_) {}
    this.broadcast({
      type: 'SYNC_UPDATE',
      settings: this.settings,
      liveState: this.liveState
    });
    this.notifyListeners('settings');
  }

  updateLiveState(partial) {
    this.liveState = {
      ...this.liveState,
      ...partial
    };
    try {
      localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(this.liveState));
    } catch (_) {}
    this.broadcast({
      type: 'SYNC_UPDATE',
      settings: this.settings,
      liveState: this.liveState
    });
    this.notifyListeners('liveState');
  }

  notifyBackgroundChanged(bgMeta = {}) {
    if (this.channel) {
      this.channel.postMessage({
        type: 'BG_MEDIA_CHANGED',
        meta: bgMeta,
        timestamp: Date.now()
      });
    }
    this.bgListeners.forEach((cb) => cb(bgMeta));
  }

  broadcast(message) {
    if (this.channel) {
      this.channel.postMessage(message);
    }
    // Synchronizuj również z lokalnym serwerem Pythona
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: this.settings,
        liveState: this.liveState
      })
    }).catch(() => {});
  }

  handleIncomingMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'SYNC_UPDATE') {
      if (data.settings) {
        this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      }
      if (data.liveState) {
        this.liveState = { ...DEFAULT_LIVE_STATE, ...data.liveState };
      }
      this.notifyListeners('both');
    } else if (data.type === 'BG_MEDIA_CHANGED') {
      this.bgListeners.forEach((cb) => cb(data.meta));
    } else if (data.type === 'REQUEST_FULL_SYNC' && this.role === 'operator') {
      this.broadcast({
        type: 'SYNC_UPDATE',
        settings: this.settings,
        liveState: this.liveState
      });
    }
  }

  requestFullSync() {
    if (this.channel) {
      this.channel.postMessage({ type: 'REQUEST_FULL_SYNC' });
    }
  }

  startServerPolling() {
    let lastBgVersion = 0;
    setInterval(async () => {
      try {
        const res = await fetch('/api/state');
        if (res.ok) {
          const data = await res.json();
          if (data.version > this.lastServerVersion && data.payload) {
            this.lastServerVersion = data.version;
            if (data.payload.settings) {
              this.settings = { ...DEFAULT_SETTINGS, ...data.payload.settings };
            }
            if (data.payload.liveState) {
              this.liveState = { ...DEFAULT_LIVE_STATE, ...data.payload.liveState };
            }
            this.notifyListeners('both');
          }
        }
      } catch (_) {}

      try {
        const bgRes = await fetch('/api/background');
        if (bgRes.ok) {
          const bgData = await bgRes.json();
          if (bgData.version > lastBgVersion) {
            lastBgVersion = bgData.version;
            this.bgListeners.forEach((cb) => cb(bgData));
          }
        }
      } catch (_) {}
    }, 600);
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onBackgroundChange(callback) {
    this.bgListeners.add(callback);
    return () => this.bgListeners.delete(callback);
  }

  notifyListeners(source) {
    this.listeners.forEach((cb) => cb({
      source,
      settings: this.settings,
      liveState: this.liveState
    }));
  }
}

/**
 * Funkcja pomocnicza generująca styl CSS cienia i obrysu dla liter na ekranie
 */
export function buildTextShadowCSS(preset, strokePx = 2) {
  const s = Number(strokePx) || 0;
  const outlineOffsets = s > 0
    ? [
        `-${s}px -${s}px 0 #000`,
        `${s}px -${s}px 0 #000`,
        `-${s}px ${s}px 0 #000`,
        `${s}px ${s}px 0 #000`,
        `0 -${s}px 0 #000`,
        `0 ${s}px 0 #000`,
        `-${s}px 0 0 #000`,
        `${s}px 0 0 #000`
      ].join(', ')
    : '';

  switch (preset) {
    case 'none':
      return outlineOffsets || 'none';
    case 'soft':
      return [outlineOffsets, '0 4px 16px rgba(0,0,0,0.65)'].filter(Boolean).join(', ');
    case 'strong-drop':
      return [outlineOffsets, '0 6px 24px rgba(0,0,0,0.92), 0 2px 6px rgba(0,0,0,0.95)'].filter(Boolean).join(', ');
    case 'neon-glow':
      return [outlineOffsets, '0 0 18px rgba(56,189,248,0.75), 0 4px 20px rgba(0,0,0,0.9)'].filter(Boolean).join(', ');
    case 'strong-outline':
    default:
      return [
        outlineOffsets || '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000',
        '0 8px 28px rgba(0,0,0,0.9), 0 2px 8px rgba(0,0,0,0.95)'
      ].filter(Boolean).join(', ');
  }
}

export function hexToRgba(hex, alpha = 1) {
  const clean = (hex || '#000000').replace('#', '');
  const bigint = parseInt(clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
