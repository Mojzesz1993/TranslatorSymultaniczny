/**
 * presenter.js
 * Logika osobnego Panelu Sterowania Prezentacją, Animacjami Tła i Playlistą (port 8766).
 */

import { renderSlideOrAnimationMedia } from './screen.js';

const dom = {
  lanHint: document.getElementById('lanHint'),
  presStatusPill: document.getElementById('presStatusPill'),
  presStatusText: document.getElementById('presStatusText'),
  btnModeBrowser: document.getElementById('btnModeBrowser'),
  btnModeNative: document.getElementById('btnModeNative'),
  btnDeactivatePres: document.getElementById('btnDeactivatePres'),

  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  uploadStatus: document.getElementById('uploadStatus'),
  presList: document.getElementById('presList'),

  selSlideTransition: document.getElementById('selSlideTransition'),
  selSubLayoutMode: document.getElementById('selSubLayoutMode'),
  selSubPosition: document.getElementById('selSubPosition'),
  rngAreaHeight: document.getElementById('rngAreaHeight'),
  lblAreaHeightVal: document.getElementById('lblAreaHeightVal'),
  rngAreaWidth: document.getElementById('rngAreaWidth'),
  lblAreaWidthVal: document.getElementById('lblAreaWidthVal'),
  rngOpacity: document.getElementById('rngOpacity'),
  lblOpacityVal: document.getElementById('lblOpacityVal'),
  rngFontScale: document.getElementById('rngFontScale'),
  lblFontScaleVal: document.getElementById('lblFontScaleVal'),

  selNativeMonitor: document.getElementById('selNativeMonitor'),
  btnOpenScreenOnMonitor: document.getElementById('btnOpenScreenOnMonitor'),
  btnNativeStart: document.getElementById('btnNativeStart'),
  btnNativeStop: document.getElementById('btnNativeStop'),

  slideCounterBadge: document.getElementById('slideCounterBadge'),
  lblCurrentMonitorTitle: document.getElementById('lblCurrentMonitorTitle'),
  lblNextMonitorTitle: document.getElementById('lblNextMonitorTitle'),
  currentSlideMonitor: document.getElementById('currentSlideMonitor'),
  currentSlideImg: document.getElementById('currentSlideImg'),
  currentSlideVideo: document.getElementById('currentSlideVideo'),
  currentSlideCanvas: document.getElementById('currentSlideCanvas'),
  currentSlideBlackout: document.getElementById('currentSlideBlackout'),
  previewSubBar: document.getElementById('previewSubBar'),
  nextSlideImg: document.getElementById('nextSlideImg'),
  nextSlideVideo: document.getElementById('nextSlideVideo'),
  nextSlideEnd: document.getElementById('nextSlideEnd'),
  speakerNotesBox: document.getElementById('speakerNotesBox'),

  animTransportBar: document.getElementById('animTransportBar'),
  btnAnimPlayPause: document.getElementById('btnAnimPlayPause'),
  btnAnimRestart: document.getElementById('btnAnimRestart'),
  btnAnimLoop: document.getElementById('btnAnimLoop'),
  selAnimLoopFade: document.getElementById('selAnimLoopFade'),
  selAnimFit: document.getElementById('selAnimFit'),
  rngAnimSeek: document.getElementById('rngAnimSeek'),
  lblAnimTime: document.getElementById('lblAnimTime'),

  btnPrevSlide: document.getElementById('btnPrevSlide'),
  btnNextSlide: document.getElementById('btnNextSlide'),
  btnBlackoutSlide: document.getElementById('btnBlackoutSlide'),
  btnToggleSubs: document.getElementById('btnToggleSubs'),

  playlistStatusBadge: document.getElementById('playlistStatusBadge'),
  btnStartPlaylist: document.getElementById('btnStartPlaylist'),
  btnClearPlaylist: document.getElementById('btnClearPlaylist'),
  playlistContainer: document.getElementById('playlistContainer'),

  thumbsGrid: document.getElementById('thumbsGrid'),
};

let currentState = null;
let cachedPresentations = [];
let cachedPlaylist = [];
let loadedDetailId = null;
let lastSlideVersion = -1;
let cachedMainPort = 8765;
let cachedMonitors = [];
let isScrubbingSeek = false;
let seekThrottleTimer = null;
let draggedPlaylistIdx = null;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const mins = String(Math.floor(total / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

async function apiGet(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}

async function apiPost(url, bodyObj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  return res.json();
}

async function sendControl(action, extra = {}) {
  try {
    const resp = await apiPost('/api/presentation/control', { action, ...extra });
    if (resp && resp.state) {
      lastSlideVersion = resp.state.version;
      renderState(resp.state);
    }
    return resp;
  } catch (err) {
    console.error('Control error:', err);
    return null;
  }
}

async function loadServerInfo() {
  try {
    const info = await apiGet('/api/server-info');
    if (info && info.mainPort) cachedMainPort = info.mainPort;
    dom.lanHint.textContent = `Pilot sieciowy (tablet/telefon): http://${info.localIp}:${info.presenterPort}  |  Główny serwer: :${info.mainPort}`;
  } catch {
    dom.lanHint.textContent = 'Panel sterowania prezentacją i animacjami tła';
  }
}

async function loadMonitors() {
  try {
    const resp = await apiGet('/api/monitors');
    const monitors = resp.monitors || [];
    cachedMonitors = monitors;
    dom.selNativeMonitor.innerHTML = '';
    monitors.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = String(m.index);
      opt.textContent = m.name;
      dom.selNativeMonitor.appendChild(opt);
    });
  } catch {
    // ignore
  }
}

function buildThumbElementHtml(thumbUrl, thumbMediaType, className = 'pres-item-thumb') {
  if (!thumbUrl) {
    return `<div class="${className}"></div>`;
  }
  if (thumbMediaType === 'video') {
    return `<video class="${className}" src="${escapeHtml(thumbUrl)}#t=0.1" muted playsinline preload="metadata"></video>`;
  }
  return `<img class="${className}" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`;
}

function renderLibraryList() {
  dom.presList.innerHTML = '';
  if (cachedPresentations.length === 0) {
    dom.presList.innerHTML = '<div style="font-size: 12.5px; color: #64748b;">Brak wgranych prezentacji i animacji.</div>';
    return;
  }

  cachedPresentations.forEach((item) => {
    const isDirectActive = Boolean(
      currentState &&
      currentState.presentationId === item.id &&
      !currentState.playlistActive &&
      currentState.active
    );
    const row = document.createElement('div');
    row.className = 'pres-item' + (isDirectActive ? ' active' : '');
    const ftype = (item.fileType || '').toUpperCase();
    const metaBadge = item.isAnimation
      ? `<span class="media-badge anim">🎞 ANIMACJA • ${escapeHtml(ftype)}</span>`
      : `<span class="media-badge slides">${item.totalSlides} slajdów • ${escapeHtml(ftype)}</span>`;

    row.innerHTML = `
      ${buildThumbElementHtml(item.thumbUrl, item.thumbMediaType, 'pres-item-thumb')}
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:700; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div style="margin-top:3px;">${metaBadge}</div>
      </div>
      <button class="btn btn-sm btn-primary btn-add-pl" type="button" title="Dodaj materiał na koniec Playlisty" style="padding:4px 8px; font-size:11.5px;">➕ Do playlisty</button>
      <button class="btn btn-sm btn-outline btn-del-pres" type="button" title="Usuń z biblioteki" style="padding:4px 8px;">🗑</button>
    `;

    row.addEventListener('click', async (e) => {
      if (e.target.closest('.btn-del-pres') || e.target.closest('.btn-add-pl')) return;
      const r = await apiPost('/api/presentation/select', { id: item.id, activate: true });
      if (r.ok && r.state) {
        lastSlideVersion = r.state.version;
        renderState(r.state);
        await loadDetail(item.id);
        renderLibraryList();
        renderPlaylistUI();
      }
    });

    row.querySelector('.btn-add-pl').addEventListener('click', async (e) => {
      e.stopPropagation();
      await appendToPlaylist(item);
    });

    row.querySelector('.btn-del-pres').addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiPost('/api/presentation/delete', { id: item.id });
      if (loadedDetailId === item.id) {
        loadedDetailId = null;
        dom.thumbsGrid.innerHTML = '<div style="font-size: 12.5px; color: #64748b;">Wybierz prezentację lub animację.</div>';
      }
      await refreshList();
    });

    dom.presList.appendChild(row);
  });
}

async function pushPlaylistUpdate(nextItems) {
  try {
    const resp = await apiPost('/api/presentation/playlist', { items: nextItems });
    if (resp && resp.ok) {
      cachedPlaylist = resp.playlist || [];
      if (resp.state) {
        lastSlideVersion = resp.state.version;
        renderState(resp.state);
      } else {
        renderPlaylistUI();
      }
    }
  } catch (err) {
    console.error('Playlist update error:', err);
  }
}

async function appendToPlaylist(libItem) {
  const newEntry = {
    presentationId: libItem.id,
    animBehavior: libItem.isAnimation ? (libItem.defaultLoop === false ? 'once-hold' : 'loop') : 'loop',
    objectFit: libItem.defaultFit || (libItem.isAnimation ? 'cover' : 'contain'),
    subtitlesRule: 'keep',
    entryTransition: 'default',
  };
  await pushPlaylistUpdate([...cachedPlaylist, newEntry]);
}

function renderPlaylistUI() {
  const total = cachedPlaylist.length;
  const plActive = Boolean(currentState && currentState.playlistActive && currentState.active);
  const activeIdx = plActive ? Number(currentState.playlistIndex) : -1;

  if (total === 0) {
    dom.playlistStatusBadge.textContent = '(Pusta)';
    dom.playlistStatusBadge.style.color = '#94a3b8';
  } else if (plActive && activeIdx >= 0) {
    dom.playlistStatusBadge.textContent = `● AKTYWNA — Pozycja ${activeIdx + 1} z ${total}`;
    dom.playlistStatusBadge.style.color = '#10b981';
  } else {
    dom.playlistStatusBadge.textContent = `(${total} ${total === 1 ? 'pozycja' : (total < 5 ? 'pozycje' : 'pozycji')} w kolejce)`;
    dom.playlistStatusBadge.style.color = '#38bdf8';
  }

  dom.btnStartPlaylist.disabled = total === 0;
  dom.btnStartPlaylist.textContent = plActive ? '⏮ Restart playlisty od 1.' : '▶ Uruchom playlistę';

  dom.playlistContainer.innerHTML = '';
  if (total === 0) {
    dom.playlistContainer.innerHTML =
      '<div style="font-size: 12.5px; color: #64748b; padding: 12px 4px;">Playlista jest pusta. Kliknij <b>➕ Do playlisty</b> przy wybranych prezentacjach lub animacjach w Bibliotece po lewej stronie.</div>';
    return;
  }

  cachedPlaylist.forEach((entry, idx) => {
    const isRowActive = plActive && currentState.playlistEntryId === entry.entryId;
    const row = document.createElement('div');
    row.className = 'playlist-row' + (isRowActive ? ' is-active' : '');
    row.draggable = true;
    row.dataset.index = String(idx);

    const ftype = (entry.fileType || '').toUpperCase();
    const badgeHtml = entry.isAnimation
      ? `<span class="media-badge anim">🎞 ANIMACJA • ${escapeHtml(ftype)}</span>`
      : `<span class="media-badge slides">${entry.totalSlides} slajdów • ${escapeHtml(ftype)}</span>`;
    const livePill = isRowActive
      ? `<span class="media-badge" style="background:rgba(16,185,129,0.25); color:#6ee7b7; border:1px solid rgba(16,185,129,0.5);">● NA ŻYWO</span>`
      : '';

    const animSelectHtml = entry.isAnimation
      ? `
        <select class="pl-mini-select sel-pl-anim" data-idx="${idx}">
          <option value="loop" ${entry.animBehavior === 'loop' ? 'selected' : ''}>🔁 Loop (w pętli)</option>
          <option value="once-hold" ${entry.animBehavior === 'once-hold' ? 'selected' : ''}>⏹ Raz i zatrzymaj na końcu</option>
          <option value="once-next" ${entry.animBehavior === 'once-next' ? 'selected' : ''}>⏭ Raz i auto-przejdź dalej</option>
        </select>
      `
      : `
        <select class="pl-mini-select" disabled title="Materiał statyczny / pokaz slajdów">
          <option>📊 Statyczny / Slajdy (ręcznie ◀ ▶)</option>
        </select>
      `;

    row.innerHTML = `
      <div class="playlist-row-main">
        <span class="drag-handle" title="Przeciągnij, aby zmienić kolejność">⠿</span>
        <span style="font-size:12.5px; font-weight:800; color:#94a3b8; min-width:22px;">${idx + 1}.</span>
        ${buildThumbElementHtml(entry.thumbUrl, entry.thumbMediaType, 'pres-item-thumb')}
        <div style="flex:1; min-width:0; cursor:pointer;" class="pl-click-play" title="Kliknij, aby odtworzyć od tej pozycji playlisty">
          <div style="font-size:13px; font-weight:700; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(entry.title)}
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:3px;">
            ${badgeHtml}
            ${livePill}
          </div>
        </div>
        <div style="display:flex; gap:5px; align-items:center;">
          <button class="btn btn-sm ${isRowActive ? 'btn-start' : 'btn-primary'} btn-pl-play" type="button" title="Uruchom od tej pozycji" style="padding:4px 9px;">▶</button>
          <button class="btn btn-sm btn-outline btn-pl-up" type="button" title="Przesuń wyżej" style="padding:4px 7px;" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-sm btn-outline btn-pl-down" type="button" title="Przesuń niżej" style="padding:4px 7px;" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-sm btn-outline btn-pl-remove" type="button" title="Usuń z playlisty" style="padding:4px 8px;">✕</button>
        </div>
      </div>

      <div class="playlist-row-settings">
        <div class="pl-mini-field">
          <label>Tryb animacji / Loop</label>
          ${animSelectHtml}
        </div>
        <div class="pl-mini-field">
          <label>Dopasowanie kadru</label>
          <select class="pl-mini-select sel-pl-fit" data-idx="${idx}">
            <option value="cover" ${entry.objectFit === 'cover' ? 'selected' : ''}>⛶ Wypełnij 16:9 (Cover)</option>
            <option value="contain" ${entry.objectFit === 'contain' ? 'selected' : ''}>🖼 Cały kadr (Contain)</option>
          </select>
        </div>
        <div class="pl-mini-field">
          <label>Napisy na tym elemencie</label>
          <select class="pl-mini-select sel-pl-subs" data-idx="${idx}">
            <option value="keep" ${entry.subtitlesRule === 'keep' ? 'selected' : ''}>💬 Bez zmian</option>
            <option value="show" ${entry.subtitlesRule === 'show' ? 'selected' : ''}>💬 Pokaż napisy</option>
            <option value="hide" ${entry.subtitlesRule === 'hide' ? 'selected' : ''}>🚫 Ukryj napisy (np. Intro)</option>
          </select>
        </div>
        <div class="pl-mini-field">
          <label>Przejście wejścia</label>
          <select class="pl-mini-select sel-pl-trans" data-idx="${idx}">
            <option value="default" ${entry.entryTransition === 'default' ? 'selected' : ''}>✨ Domyślne z panelu</option>
            <option value="fade" ${entry.entryTransition === 'fade' ? 'selected' : ''}>Przenikanie (Crossfade)</option>
            <option value="slide-fade" ${entry.entryTransition === 'slide-fade' ? 'selected' : ''}>Przesunięcie (Slide)</option>
            <option value="zoom-fade" ${entry.entryTransition === 'zoom-fade' ? 'selected' : ''}>Zbliżenie (Zoom)</option>
            <option value="none" ${entry.entryTransition === 'none' ? 'selected' : ''}>Brak (Natychmiastowe)</option>
          </select>
        </div>
      </div>
    `;

    // Akcje uruchomienia od klikniętego punktu
    const startFromHere = () => sendControl('playlistStart', { index: idx, entryId: entry.entryId });
    row.querySelector('.btn-pl-play').addEventListener('click', startFromHere);
    row.querySelector('.pl-click-play').addEventListener('click', startFromHere);

    // Przesuwanie góra / dół / usuwanie
    row.querySelector('.btn-pl-up').addEventListener('click', () => {
      if (idx <= 0) return;
      const copy = [...cachedPlaylist];
      [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
      pushPlaylistUpdate(copy);
    });

    row.querySelector('.btn-pl-down').addEventListener('click', () => {
      if (idx >= cachedPlaylist.length - 1) return;
      const copy = [...cachedPlaylist];
      [copy[idx + 1], copy[idx]] = [copy[idx], copy[idx + 1]];
      pushPlaylistUpdate(copy);
    });

    row.querySelector('.btn-pl-remove').addEventListener('click', () => {
      const copy = cachedPlaylist.filter((_, i) => i !== idx);
      pushPlaylistUpdate(copy);
    });

    // Zmiana predefiniowanych ustawień na elemencie playlisty
    row.querySelector('.sel-pl-anim')?.addEventListener('change', (e) => {
      const copy = cachedPlaylist.map((it, i) => (i === idx ? { ...it, animBehavior: e.target.value } : it));
      pushPlaylistUpdate(copy);
    });

    row.querySelector('.sel-pl-fit').addEventListener('change', (e) => {
      const copy = cachedPlaylist.map((it, i) => (i === idx ? { ...it, objectFit: e.target.value } : it));
      pushPlaylistUpdate(copy);
    });

    row.querySelector('.sel-pl-subs').addEventListener('change', (e) => {
      const copy = cachedPlaylist.map((it, i) => (i === idx ? { ...it, subtitlesRule: e.target.value } : it));
      pushPlaylistUpdate(copy);
    });

    row.querySelector('.sel-pl-trans').addEventListener('change', (e) => {
      const copy = cachedPlaylist.map((it, i) => (i === idx ? { ...it, entryTransition: e.target.value } : it));
      pushPlaylistUpdate(copy);
    });

    // Drag & Drop zmiany kolejności wierszy
    row.addEventListener('dragstart', (e) => {
      if (e.target && ['SELECT', 'BUTTON', 'INPUT'].includes(e.target.tagName)) {
        e.preventDefault();
        return;
      }
      draggedPlaylistIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });

    row.addEventListener('dragover', (e) => {
      if (draggedPlaylistIdx === null || draggedPlaylistIdx === idx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (draggedPlaylistIdx === null || draggedPlaylistIdx === idx) return;
      const copy = [...cachedPlaylist];
      const [moved] = copy.splice(draggedPlaylistIdx, 1);
      copy.splice(idx, 0, moved);
      draggedPlaylistIdx = null;
      pushPlaylistUpdate(copy);
    });

    row.addEventListener('dragend', () => {
      draggedPlaylistIdx = null;
      dom.playlistContainer.querySelectorAll('.playlist-row').forEach((el) => el.classList.remove('drag-over'));
    });

    dom.playlistContainer.appendChild(row);
  });
}

async function refreshList() {
  try {
    const resp = await apiGet('/api/presentation/list');
    cachedPresentations = resp.presentations || [];
    cachedPlaylist = resp.playlist || [];
    if (resp.state) {
      lastSlideVersion = resp.state.version;
      renderState(resp.state);
    }
    renderLibraryList();
    renderPlaylistUI();
  } catch (err) {
    console.error('List error:', err);
  }
}

async function loadDetail(presId) {
  if (!presId) return;
  try {
    const resp = await apiGet(`/api/presentation/detail?id=${encodeURIComponent(presId)}`);
    if (!resp.ok || !resp.presentation) return;
    loadedDetailId = presId;
    const pres = resp.presentation;
    const slides = pres.slides || [];
    dom.thumbsGrid.innerHTML = '';

    slides.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'thumb-card' + (currentState && currentState.currentSlide === s.slideNumber ? ' active' : '');
      card.dataset.slide = String(s.slideNumber);
      const mediaHtml = s.mediaType === 'video'
        ? `<video src="${escapeHtml(s.imageUrl)}#t=0.1" muted playsinline preload="metadata" style="width:100%; aspect-ratio:16/9; object-fit:cover; display:block;"></video>`
        : `<img src="${escapeHtml(s.imageUrl)}" loading="lazy" alt="Slajd ${s.slideNumber}" />`;
      const numLabel = pres.isAnimation ? '🎞 ANIMACJA' : String(s.slideNumber);
      card.innerHTML = `
        ${mediaHtml}
        <span class="thumb-num">${numLabel}</span>
      `;
      card.addEventListener('click', () => {
        if (pres.isAnimation) {
          sendControl('animRestart');
        } else {
          sendControl('goto', { slide: s.slideNumber });
        }
      });
      dom.thumbsGrid.appendChild(card);
    });
  } catch (err) {
    console.error('Detail error:', err);
  }
}

function getLocalAnimPlaybackMetrics() {
  if (!currentState || !currentState.isAnimation) {
    return { cur: 0, dur: 0, playing: false };
  }
  if (currentState.currentMediaType === 'video' && dom.currentSlideVideo) {
    if (dom.currentSlideVideo._videoLoopPlayer) {
      return dom.currentSlideVideo._videoLoopPlayer.getMetrics();
    }
    const dur = Number.isFinite(dom.currentSlideVideo.duration) ? dom.currentSlideVideo.duration : 0;
    const cur = Number.isFinite(dom.currentSlideVideo.currentTime) ? dom.currentSlideVideo.currentTime : 0;
    return { cur, dur, playing: !dom.currentSlideVideo.paused && !dom.currentSlideVideo.ended };
  }
  if (currentState.currentMediaType === 'anim-image' && dom.currentSlideCanvas && dom.currentSlideCanvas._animPlayer) {
    const p = dom.currentSlideCanvas._animPlayer;
    return { cur: p.currentTimeSec || 0, dur: p.totalDurationSec || 0, playing: Boolean(p.playing && !p.ended) };
  }
  return { cur: 0, dur: 0, playing: Boolean(currentState.animPlaying) };
}

function updateAnimTransportClock() {
  if (!currentState || !currentState.isAnimation || dom.animTransportBar.classList.contains('hidden')) {
    return;
  }
  const { cur, dur, playing } = getLocalAnimPlaybackMetrics();
  dom.btnAnimPlayPause.textContent = playing ? '⏸ Pauza' : '▶ Odtwórz';

  if (dur > 0) {
    dom.rngAnimSeek.disabled = false;
    dom.rngAnimSeek.max = String(dur.toFixed(2));
    if (!isScrubbingSeek) {
      dom.rngAnimSeek.value = String(Math.min(dur, cur).toFixed(2));
    }
    const shownCur = isScrubbingSeek ? Number(dom.rngAnimSeek.value) : cur;
    dom.lblAnimTime.textContent = `${formatClock(shownCur)} / ${formatClock(dur)}`;
  } else {
    dom.rngAnimSeek.disabled = true;
    dom.rngAnimSeek.value = '0';
    dom.lblAnimTime.textContent = '00:00 / —:—';
  }
}

setInterval(updateAnimTransportClock, 150);

function renderState(st) {
  currentState = st;
  const active = Boolean(st.active && st.presentationId);

  if (active) {
    dom.presStatusPill.classList.add('is-running');
    const kindStr = st.isAnimation
      ? 'ANIMACJA TŁA'
      : (st.mode === 'native' ? 'NATYWNY PPT' : 'PRZEGLĄDARKA');
    const plPrefix = st.playlistActive ? `[PLAYLISTA ${st.playlistIndex + 1}/${st.playlistTotal}] ` : '';
    dom.presStatusText.textContent = `${plPrefix}${st.title} (${kindStr})`;
  } else {
    dom.presStatusPill.classList.remove('is-running');
    dom.presStatusText.textContent = st.presentationId ? `${st.title} (WSTRZYMANA)` : 'BRAK AKTYWNEJ PREZENTACJI';
  }

  dom.btnModeBrowser.className = st.mode === 'browser' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  dom.btnModeNative.className = st.mode === 'native' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  dom.btnModeNative.disabled = Boolean(st.isAnimation);
  dom.btnNativeStart.disabled = Boolean(st.isAnimation);

  if (st.isAnimation) {
    dom.slideCounterBadge.textContent = st.playlistActive
      ? `Playlista ${st.playlistIndex + 1} / ${st.playlistTotal} • Animacja`
      : '🎞 Animacja tła';
  } else if (st.totalSlides > 0) {
    dom.slideCounterBadge.textContent = st.playlistActive
      ? `Playlista ${st.playlistIndex + 1}/${st.playlistTotal} • Slajd ${st.currentSlide}/${st.totalSlides}`
      : `Slajd ${st.currentSlide} / ${st.totalSlides}`;
  } else {
    dom.slideCounterBadge.textContent = 'Slajd — / —';
  }

  // Renderowanie bieżącego slajdu / animacji w monitorze podglądu
  if (st.presentationId && st.currentSlideUrl) {
    renderSlideOrAnimationMedia(
      dom.currentSlideMonitor,
      {
        slideImg: dom.currentSlideImg,
        slideVideo: dom.currentSlideVideo,
        slideCanvas: dom.currentSlideCanvas,
      },
      { ...st, blackoutSlide: false },
      {
        onAnimEnded: (cueSeq) => {
          sendControl('animEnded', { cueSeq });
        },
      }
    );
  } else {
    renderSlideOrAnimationMedia(
      dom.currentSlideMonitor,
      {
        slideImg: dom.currentSlideImg,
        slideVideo: dom.currentSlideVideo,
        slideCanvas: dom.currentSlideCanvas,
      },
      null
    );
  }

  dom.currentSlideBlackout.classList.toggle('hidden', !st.blackoutSlide);

  // Pasek transportu animacji
  if (st.presentationId && st.isAnimation) {
    dom.animTransportBar.classList.remove('hidden');
    if (st.animLoop) {
      dom.btnAnimLoop.className = 'btn btn-sm btn-start';
      dom.btnAnimLoop.textContent = '🔁 Loop: WŁ.';
    } else if (st.animAutoAdvance && st.playlistActive) {
      dom.btnAnimLoop.className = 'btn btn-sm btn-indigo';
      dom.btnAnimLoop.textContent = '⏭ Loop: WYŁ. (Auto-dalej)';
    } else {
      dom.btnAnimLoop.className = 'btn btn-sm btn-outline';
      dom.btnAnimLoop.textContent = '⏹ Loop: WYŁ. (Stop na końcu)';
    }
    if (dom.selAnimLoopFade) {
      const cf = Number(st.loopCrossfadeSec ?? 1.2);
      dom.selAnimLoopFade.value = String(cf);
      dom.selAnimLoopFade.disabled = !st.animLoop;
      dom.selAnimLoopFade.style.opacity = st.animLoop ? '1' : '0.5';
    }
    dom.selAnimFit.value = st.objectFit || 'cover';
    updateAnimTransportClock();
  } else {
    dom.animTransportBar.classList.add('hidden');
  }

  // Podgląd następnego slajdu / kolejnej pozycji z playlisty
  dom.lblNextMonitorTitle.textContent = st.nextSlideLabel
    ? st.nextSlideLabel.toUpperCase()
    : 'NASTĘPNY SLAJD / KOLEJNA POZYCJA';

  if (st.nextSlideUrl) {
    dom.nextSlideEnd.classList.add('hidden');
    if (st.nextSlideMediaType === 'video') {
      dom.nextSlideImg.classList.add('hidden');
      dom.nextSlideVideo.classList.remove('hidden');
      const targetNextVid = `${st.nextSlideUrl}#t=0.1`;
      if (dom.nextSlideVideo.getAttribute('data-src') !== targetNextVid) {
        dom.nextSlideVideo.setAttribute('data-src', targetNextVid);
        dom.nextSlideVideo.src = targetNextVid;
      }
    } else {
      dom.nextSlideVideo.classList.add('hidden');
      dom.nextSlideImg.src = st.nextSlideUrl;
      dom.nextSlideImg.classList.remove('hidden');
    }
  } else {
    dom.nextSlideImg.classList.add('hidden');
    dom.nextSlideVideo.classList.add('hidden');
    dom.nextSlideEnd.classList.toggle('hidden', !st.presentationId);
  }

  const notes = (st.currentSpeakerNotes || '').trim();
  const sText = (st.currentSlideText || '').trim();
  if (notes || sText) {
    dom.speakerNotesBox.textContent = [
      notes ? `📝 Notatki: ${notes}` : '',
      sText ? `📄 Tekst ze slajdu: ${sText}` : '',
    ].filter(Boolean).join('\n\n');
  } else if (st.isAnimation) {
    dom.speakerNotesBox.textContent = 'Animacja tła (ścieżka wideo wyciszona). Napisy tłumaczenia wyświetlane zgodnie z ustawieniami panelu.';
  } else {
    dom.speakerNotesBox.textContent = 'Brak notatek dla tego slajdu.';
  }

  dom.btnBlackoutSlide.className = st.blackoutSlide ? 'btn btn-danger' : 'btn btn-outline';
  dom.btnToggleSubs.className = st.hideSubtitles ? 'btn btn-danger' : 'btn btn-outline';
  dom.btnToggleSubs.textContent = st.hideSubtitles ? '💬 Napisy UKRYTE (H)' : '💬 Ukryj napisy (H)';

  dom.selSlideTransition.value = st.slideTransition || 'fade';
  dom.selSubLayoutMode.value = st.subtitleLayoutMode || 'overlay';
  dom.selSubPosition.value = st.subtitlePosition || 'bottom';

  const areaHPct = Math.round(st.subtitleAreaHeightPct ?? 22);
  dom.rngAreaHeight.value = String(areaHPct);
  dom.lblAreaHeightVal.textContent = `${areaHPct}%`;

  const areaWPct = Math.round(st.subtitleAreaWidthPct ?? 90);
  dom.rngAreaWidth.value = String(areaWPct);
  dom.lblAreaWidthVal.textContent = `${areaWPct}%`;

  const opPct = Math.round((st.subtitleOpacity ?? 0.78) * 100);
  dom.rngOpacity.value = String(opPct);
  dom.lblOpacityVal.textContent = `${opPct}%`;

  const fsPct = Math.round((st.subtitleFontScale ?? 0.85) * 100);
  dom.rngFontScale.value = String(fsPct);
  dom.lblFontScaleVal.textContent = `${fsPct}%`;

  if (dom.selNativeMonitor.options.length > 0 && st.nativeMonitorIndex !== undefined) {
    dom.selNativeMonitor.value = String(st.nativeMonitorIndex);
  }

  if (st.presentationId && st.presentationId !== loadedDetailId) {
    loadDetail(st.presentationId);
  }

  dom.thumbsGrid.querySelectorAll('.thumb-card').forEach((card) => {
    card.classList.toggle('active', Number(card.dataset.slide) === st.currentSlide);
  });

  renderLibraryList();
  renderPlaylistUI();
}

async function pollLoop() {
  try {
    const [presState, mainState] = await Promise.all([
      apiGet('/api/presentation'),
      apiGet('/api/state'),
    ]);

    if (presState && presState.version !== lastSlideVersion) {
      lastSlideVersion = presState.version;
      const plResp = await apiGet('/api/presentation/playlist');
      if (plResp && Array.isArray(plResp.playlist)) {
        cachedPlaylist = plResp.playlist;
      }
      renderState(presState);
    }

    // Podgląd napisów na żywo na bieżącym slajdzie / animacji w panelu
    const payload = mainState && mainState.payload;
    const live = payload && payload.liveState;
    const items = (live && Array.isArray(live.items)) ? live.items : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    const hideSubs = Boolean(presState && presState.hideSubtitles) || Boolean(live && live.blackout);
    const layoutMode = (presState && presState.subtitleLayoutMode) || 'overlay';
    const pos = (presState && presState.subtitlePosition) || 'bottom';
    const areaHPct = Math.max(10, Math.min(45, Number((presState && presState.subtitleAreaHeightPct) ?? 22)));
    const areaWPct = Math.max(50, Math.min(100, Number((presState && presState.subtitleAreaWidthPct) ?? 90)));
    const isSplit = layoutMode === 'split' && !hideSubs;

    const topVal = isSplit && pos === 'top' ? `${areaHPct}%` : '0';
    const heightVal = isSplit ? `${100 - areaHPct}%` : '100%';
    dom.currentSlideMonitor.querySelectorAll('img, video, canvas').forEach((el) => {
      el.style.top = topVal;
      el.style.height = heightVal;
    });
    if (dom.currentSlideVideo && dom.currentSlideVideo._videoLoopPlayer) {
      dom.currentSlideVideo._videoLoopPlayer.syncStyles();
    }

    if (hideSubs || !last || !last.en) {
      dom.previewSubBar.classList.add('hidden');
    } else {
      dom.previewSubBar.classList.remove('hidden');
      dom.previewSubBar.textContent = last.en;
      const effectivePos = isSplit ? (pos === 'top' ? 'top' : 'bottom') : pos;
      dom.previewSubBar.className = `slide-monitor-subs pos-${effectivePos}`;
      const op = presState ? (presState.subtitleOpacity ?? 0.78) : 0.78;
      dom.previewSubBar.style.background = `rgba(6, 11, 25, ${op})`;
      dom.previewSubBar.style.width = `${areaWPct}%`;
      if (isSplit) {
        dom.previewSubBar.style.top = effectivePos === 'top' ? '0' : 'auto';
        dom.previewSubBar.style.bottom = effectivePos === 'bottom' ? '0' : 'auto';
        dom.previewSubBar.style.height = `${areaHPct}%`;
        dom.previewSubBar.style.minHeight = `${areaHPct}%`;
        dom.previewSubBar.style.borderRadius = areaWPct >= 100 ? '0px' : '10px';
      } else {
        dom.previewSubBar.style.top = '';
        dom.previewSubBar.style.bottom = '';
        dom.previewSubBar.style.height = 'auto';
        dom.previewSubBar.style.minHeight = `${areaHPct}%`;
        dom.previewSubBar.style.borderRadius = '10px';
      }
    }
  } catch {
    // ignore transient poll errors
  } finally {
    setTimeout(pollLoop, 300);
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (files.length === 0) return;

  dom.uploadStatus.classList.remove('hidden');
  const preserveLivePlaylist = Boolean(currentState && currentState.active && currentState.playlistActive);

  let okCount = 0;
  let lastUploadedPres = null;
  let lastState = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isLast = i === files.length - 1;
    const shouldActivate = !preserveLivePlaylist && isLast;
    dom.uploadStatus.textContent = `⏳ Przesyłanie (${i + 1}/${files.length}): "${file.name}"...`;

    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`/api/presentation/upload?activate=${shouldActivate ? '1' : '0'}`, {
        method: 'POST',
        headers: { 'X-File-Name': encodeURIComponent(file.name) },
        body: buf,
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || 'Błąd przetwarzania pliku');
      }
      okCount += 1;
      lastUploadedPres = data.presentation;
      if (data.state) lastState = data.state;
    } catch (err) {
      dom.uploadStatus.textContent = `❌ Błąd przy "${file.name}": ${err.message}`;
      await refreshList();
      return;
    }
  }

  if (okCount === 1 && lastUploadedPres) {
    const desc = lastUploadedPres.isAnimation
      ? 'animacja tła'
      : `${lastUploadedPres.totalSlides} slajdów`;
    dom.uploadStatus.textContent = `✅ Gotowe: "${lastUploadedPres.title}" (${desc})`;
  } else {
    dom.uploadStatus.textContent = `✅ Dodano do biblioteki ${okCount} plików.`;
  }

  if (lastState) {
    lastSlideVersion = lastState.version;
    renderState(lastState);
  }
  if (lastUploadedPres && (!preserveLivePlaylist)) {
    await loadDetail(lastUploadedPres.id);
  }
  await refreshList();
}

// Zdarzenia Drag & Drop i wyboru plików
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    uploadFiles(e.target.files);
    e.target.value = '';
  }
});
dom.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.dropZone.classList.add('dragover');
});
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('dragover'));
dom.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dom.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    uploadFiles(e.dataTransfer.files);
  }
});

// Przyciski paska sterowania animacją (Transport Bar)
dom.btnAnimPlayPause.addEventListener('click', () => {
  const { cur, playing } = getLocalAnimPlaybackMetrics();
  sendControl(playing ? 'animPause' : 'animPlay', { timeSec: cur });
});

dom.btnAnimRestart.addEventListener('click', () => {
  sendControl('animRestart');
});

dom.btnAnimLoop.addEventListener('click', () => {
  const nextLoop = !(currentState && currentState.animLoop);
  sendControl('animLoop', { loop: nextLoop }).then(() => refreshList());
});

dom.selAnimLoopFade?.addEventListener('change', () => {
  sendControl('settings', { loopCrossfadeSec: Number(dom.selAnimLoopFade.value) });
});

dom.selAnimFit.addEventListener('change', () => {
  sendControl('objectFit', { objectFit: dom.selAnimFit.value }).then(() => refreshList());
});

dom.rngAnimSeek.addEventListener('pointerdown', () => {
  isScrubbingSeek = true;
});

dom.rngAnimSeek.addEventListener('input', () => {
  isScrubbingSeek = true;
  const val = Number(dom.rngAnimSeek.value);
  const { dur } = getLocalAnimPlaybackMetrics();
  dom.lblAnimTime.textContent = `${formatClock(val)} / ${formatClock(dur)}`;
  if (!seekThrottleTimer) {
    seekThrottleTimer = setTimeout(() => {
      seekThrottleTimer = null;
      sendControl('animSeek', { timeSec: Number(dom.rngAnimSeek.value) });
    }, 120);
  }
});

dom.rngAnimSeek.addEventListener('change', () => {
  if (seekThrottleTimer) {
    clearTimeout(seekThrottleTimer);
    seekThrottleTimer = null;
  }
  const val = Number(dom.rngAnimSeek.value);
  isScrubbingSeek = false;
  sendControl('animSeek', { timeSec: val });
});

window.addEventListener('pointerup', () => {
  if (isScrubbingSeek) {
    isScrubbingSeek = false;
  }
});

// Przyciski Playlisty
dom.btnStartPlaylist.addEventListener('click', () => {
  if (cachedPlaylist.length > 0) {
    sendControl('playlistStart', { index: 0 });
  }
});

dom.btnClearPlaylist.addEventListener('click', () => {
  if (cachedPlaylist.length === 0) return;
  if (!confirm('Czy na pewno wyczyścić całą Playlistę? (Pliki pozostaną w Bibliotece).')) return;
  pushPlaylistUpdate([]);
});

// Przyciski pilota i trybów
dom.btnPrevSlide.addEventListener('click', () => sendControl('prev'));
dom.btnNextSlide.addEventListener('click', () => sendControl('next'));
dom.btnBlackoutSlide.addEventListener('click', () => sendControl('blackout'));
dom.btnToggleSubs.addEventListener('click', () => sendControl('toggleSubtitles'));
dom.btnDeactivatePres.addEventListener('click', () => sendControl('deactivate'));
dom.btnModeBrowser.addEventListener('click', () => sendControl('mode', { mode: 'browser' }));
dom.btnModeNative.addEventListener('click', () => sendControl('mode', { mode: 'native' }));

dom.btnOpenScreenOnMonitor?.addEventListener('click', async () => {
  try {
    const resp = await apiGet('/api/monitors');
    if (resp && Array.isArray(resp.monitors)) cachedMonitors = resp.monitors;
  } catch {
    // ignore
  }
  const monIdx = Number(dom.selNativeMonitor.value || 0);
  const mon = cachedMonitors.find((m) => Number(m.index) === monIdx) || cachedMonitors[0];
  const host = window.location.hostname || 'localhost';
  const screenUrl = `http://${host}:${cachedMainPort}/screen.html`;
  const features = mon
    ? `left=${mon.left},top=${mon.top},width=${mon.width},height=${mon.height},menubar=no,toolbar=no,location=no,status=no`
    : 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no';
  window.open(screenUrl, 'DebatePresentationScreen', features);
});

dom.btnNativeStart.addEventListener('click', () => {
  const monitorIndex = Number(dom.selNativeMonitor.value || 0);
  sendControl('settings', { nativeMonitorIndex: monitorIndex });
  sendControl('nativeStart');
});
dom.btnNativeStop.addEventListener('click', () => sendControl('nativeStop'));

function pushSubtitleSettings() {
  sendControl('settings', {
    slideTransition: dom.selSlideTransition.value,
    subtitleLayoutMode: dom.selSubLayoutMode.value,
    subtitlePosition: dom.selSubPosition.value,
    subtitleAreaHeightPct: Number(dom.rngAreaHeight.value),
    subtitleAreaWidthPct: Number(dom.rngAreaWidth.value),
    subtitleOpacity: Number(dom.rngOpacity.value) / 100,
    subtitleFontScale: Number(dom.rngFontScale.value) / 100,
    nativeMonitorIndex: Number(dom.selNativeMonitor.value || 0),
  });
}

dom.selSlideTransition.addEventListener('change', pushSubtitleSettings);
dom.selSubLayoutMode.addEventListener('change', pushSubtitleSettings);
dom.selSubPosition.addEventListener('change', pushSubtitleSettings);
dom.selNativeMonitor.addEventListener('change', pushSubtitleSettings);
dom.rngAreaHeight.addEventListener('input', () => {
  dom.lblAreaHeightVal.textContent = `${dom.rngAreaHeight.value}%`;
});
dom.rngAreaHeight.addEventListener('change', pushSubtitleSettings);
dom.rngAreaWidth.addEventListener('input', () => {
  dom.lblAreaWidthVal.textContent = `${dom.rngAreaWidth.value}%`;
});
dom.rngAreaWidth.addEventListener('change', pushSubtitleSettings);
dom.rngOpacity.addEventListener('input', () => {
  dom.lblOpacityVal.textContent = `${dom.rngOpacity.value}%`;
});
dom.rngOpacity.addEventListener('change', pushSubtitleSettings);
dom.rngFontScale.addEventListener('input', () => {
  dom.lblFontScaleVal.textContent = `${dom.rngFontScale.value}%`;
});
dom.rngFontScale.addEventListener('change', pushSubtitleSettings);

// Skróty klawiszowe pilota
window.addEventListener('keydown', (e) => {
  if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    sendControl('next');
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    sendControl('prev');
  } else if (e.key.toLowerCase() === 'b') {
    e.preventDefault();
    sendControl('blackout');
  } else if (e.key.toLowerCase() === 'h') {
    e.preventDefault();
    sendControl('toggleSubtitles');
  } else if (e.key.toLowerCase() === 'l' && currentState && currentState.isAnimation) {
    e.preventDefault();
    sendControl('animLoop', { loop: !currentState.animLoop }).then(() => refreshList());
  } else if (e.key.toLowerCase() === 'r' && currentState && currentState.isAnimation) {
    e.preventDefault();
    sendControl('animRestart');
  }
});

// Start
loadServerInfo();
loadMonitors();
refreshList();
pollLoop();
