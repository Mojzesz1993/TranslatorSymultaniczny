/**
 * presenter.js
 * Logika osobnego Panelu Sterowania Prezentacją (port 8766).
 */

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

  selSubPosition: document.getElementById('selSubPosition'),
  rngOpacity: document.getElementById('rngOpacity'),
  lblOpacityVal: document.getElementById('lblOpacityVal'),
  rngFontScale: document.getElementById('rngFontScale'),
  lblFontScaleVal: document.getElementById('lblFontScaleVal'),

  selNativeMonitor: document.getElementById('selNativeMonitor'),
  btnNativeStart: document.getElementById('btnNativeStart'),
  btnNativeStop: document.getElementById('btnNativeStop'),

  slideCounterBadge: document.getElementById('slideCounterBadge'),
  currentSlideImg: document.getElementById('currentSlideImg'),
  currentSlideBlackout: document.getElementById('currentSlideBlackout'),
  previewSubBar: document.getElementById('previewSubBar'),
  nextSlideImg: document.getElementById('nextSlideImg'),
  nextSlideEnd: document.getElementById('nextSlideEnd'),
  speakerNotesBox: document.getElementById('speakerNotesBox'),

  btnPrevSlide: document.getElementById('btnPrevSlide'),
  btnNextSlide: document.getElementById('btnNextSlide'),
  btnBlackoutSlide: document.getElementById('btnBlackoutSlide'),
  btnToggleSubs: document.getElementById('btnToggleSubs'),
  thumbsGrid: document.getElementById('thumbsGrid'),
};

let currentState = null;
let loadedDetailId = null;
let lastSlideVersion = -1;

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
      renderState(resp.state);
    }
  } catch (err) {
    console.error('Control error:', err);
  }
}

async function loadServerInfo() {
  try {
    const info = await apiGet('/api/server-info');
    dom.lanHint.textContent = `Pilot sieciowy (tablet/telefon): http://${info.localIp}:${info.presenterPort}  |  Główny serwer: :${info.mainPort}`;
  } catch {
    dom.lanHint.textContent = 'Panel sterowania prezentacją';
  }
}

async function loadMonitors() {
  try {
    const resp = await apiGet('/api/monitors');
    const monitors = resp.monitors || [];
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

async function refreshList() {
  try {
    const resp = await apiGet('/api/presentation/list');
    const list = resp.presentations || [];
    if (resp.state) renderState(resp.state);

    dom.presList.innerHTML = '';
    if (list.length === 0) {
      dom.presList.innerHTML = '<div style="font-size: 12.5px; color: #64748b;">Brak wgranych prezentacji.</div>';
      return;
    }

    list.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'pres-item' + (currentState && currentState.presentationId === item.id ? ' active' : '');
      row.innerHTML = `
        <img class="pres-item-thumb" src="${item.thumbUrl || ''}" alt="" />
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:700; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title}</div>
          <div style="font-size:11px; color:#94a3b8;">${item.totalSlides} slajdów • ${(item.fileType || '').toUpperCase()}</div>
        </div>
        <button class="btn btn-sm btn-outline btn-del-pres" title="Usuń prezentację">🗑</button>
      `;

      row.addEventListener('click', async (e) => {
        if (e.target.closest('.btn-del-pres')) return;
        const r = await apiPost('/api/presentation/select', { id: item.id, activate: true });
        if (r.ok && r.state) {
          renderState(r.state);
          await loadDetail(item.id);
          await refreshList();
        }
      });

      row.querySelector('.btn-del-pres').addEventListener('click', async (e) => {
        e.stopPropagation();
        await apiPost('/api/presentation/delete', { id: item.id });
        if (loadedDetailId === item.id) {
          loadedDetailId = null;
          dom.thumbsGrid.innerHTML = '<div style="font-size: 12.5px; color: #64748b;">Wybierz prezentację.</div>';
        }
        await refreshList();
      });

      dom.presList.appendChild(row);
    });
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
    const slides = resp.presentation.slides || [];
    dom.thumbsGrid.innerHTML = '';

    slides.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'thumb-card' + (currentState && currentState.currentSlide === s.slideNumber ? ' active' : '');
      card.dataset.slide = String(s.slideNumber);
      card.innerHTML = `
        <img src="${s.imageUrl}" loading="lazy" alt="Slajd ${s.slideNumber}" />
        <span class="thumb-num">${s.slideNumber}</span>
      `;
      card.addEventListener('click', () => sendControl('goto', { slide: s.slideNumber }));
      dom.thumbsGrid.appendChild(card);
    });
  } catch (err) {
    console.error('Detail error:', err);
  }
}

function renderState(st) {
  currentState = st;
  const active = Boolean(st.active && st.presentationId);

  if (active) {
    dom.presStatusPill.classList.add('listening');
    dom.presStatusText.textContent = `${st.title} (${st.mode === 'native' ? 'NATYWNY PPT' : 'PRZEGLĄDARKA'})`;
  } else {
    dom.presStatusPill.classList.remove('listening');
    dom.presStatusText.textContent = st.presentationId ? `${st.title} (WSTRZYMANA)` : 'BRAK AKTYWNEJ PREZENTACJI';
  }

  dom.btnModeBrowser.className = st.mode === 'browser' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  dom.btnModeNative.className = st.mode === 'native' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';

  dom.slideCounterBadge.textContent = st.totalSlides > 0 ? `Slajd ${st.currentSlide} / ${st.totalSlides}` : 'Slajd — / —';

  if (st.currentSlideUrl) {
    dom.currentSlideImg.src = st.currentSlideUrl;
    dom.currentSlideImg.classList.remove('hidden');
  } else {
    dom.currentSlideImg.removeAttribute('src');
  }

  dom.currentSlideBlackout.classList.toggle('hidden', !st.blackoutSlide);

  if (st.nextSlideUrl) {
    dom.nextSlideImg.src = st.nextSlideUrl;
    dom.nextSlideImg.classList.remove('hidden');
    dom.nextSlideEnd.classList.add('hidden');
  } else {
    dom.nextSlideImg.classList.add('hidden');
    dom.nextSlideEnd.classList.toggle('hidden', !st.presentationId);
  }

  const notes = (st.currentSpeakerNotes || '').trim();
  const sText = (st.currentSlideText || '').trim();
  if (notes || sText) {
    dom.speakerNotesBox.textContent = [
      notes ? `📝 Notatki: ${notes}` : '',
      sText ? `📄 Tekst ze slajdu: ${sText}` : '',
    ].filter(Boolean).join('\n\n');
  } else {
    dom.speakerNotesBox.textContent = 'Brak notatek dla tego slajdu.';
  }

  dom.btnBlackoutSlide.className = st.blackoutSlide ? 'btn btn-danger' : 'btn btn-outline';
  dom.btnToggleSubs.className = st.hideSubtitles ? 'btn btn-danger' : 'btn btn-outline';
  dom.btnToggleSubs.textContent = st.hideSubtitles ? '💬 Napisy UKRYTE (H)' : '💬 Ukryj napisy (H)';

  dom.selSubPosition.value = st.subtitlePosition || 'bottom';
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

  // Podświetl miniaturkę bieżącego slajdu
  dom.thumbsGrid.querySelectorAll('.thumb-card').forEach((card) => {
    card.classList.toggle('active', Number(card.dataset.slide) === st.currentSlide);
  });
}

async function pollLoop() {
  try {
    const [presState, mainState] = await Promise.all([
      apiGet('/api/presentation'),
      apiGet('/api/state'),
    ]);

    if (presState && presState.version !== lastSlideVersion) {
      lastSlideVersion = presState.version;
      renderState(presState);
    }

    // Podgląd napisów na żywo na bieżącym slajdzie w panelu
    const payload = mainState && mainState.payload;
    const live = payload && payload.liveState;
    const items = (live && Array.isArray(live.items)) ? live.items : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    const hideSubs = Boolean(presState && presState.hideSubtitles) || Boolean(live && live.blackout);

    if (hideSubs || !last || !last.en) {
      dom.previewSubBar.classList.add('hidden');
    } else {
      dom.previewSubBar.classList.remove('hidden');
      dom.previewSubBar.textContent = last.en;
      const pos = (presState && presState.subtitlePosition) || 'bottom';
      dom.previewSubBar.className = `slide-monitor-subs pos-${pos}`;
      const op = presState ? (presState.subtitleOpacity ?? 0.78) : 0.78;
      dom.previewSubBar.style.background = `rgba(6, 11, 25, ${op})`;
    }
  } catch {
    // ignore transient poll errors
  } finally {
    setTimeout(pollLoop, 300);
  }
}

async function uploadFile(file) {
  if (!file) return;
  dom.uploadStatus.classList.remove('hidden');
  dom.uploadStatus.textContent = `⏳ Przesyłanie i konwersja pliku "${file.name}" (może potrwać kilka sekund)...`;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/presentation/upload', {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(file.name) },
      body: buf,
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'Błąd konwersji');
    }
    dom.uploadStatus.textContent = `✅ Gotowe: "${data.presentation.title}" (${data.presentation.totalSlides} slajdów)`;
    if (data.state) renderState(data.state);
    await loadDetail(data.presentation.id);
    await refreshList();
  } catch (err) {
    dom.uploadStatus.textContent = `❌ Błąd: ${err.message}`;
  }
}

// Zdarzenia Drag & Drop i wyboru pliku
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    uploadFile(e.target.files[0]);
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
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    uploadFile(e.dataTransfer.files[0]);
  }
});

// Przyciski pilota i trybów
dom.btnPrevSlide.addEventListener('click', () => sendControl('prev'));
dom.btnNextSlide.addEventListener('click', () => sendControl('next'));
dom.btnBlackoutSlide.addEventListener('click', () => sendControl('blackout'));
dom.btnToggleSubs.addEventListener('click', () => sendControl('toggleSubtitles'));
dom.btnDeactivatePres.addEventListener('click', () => sendControl('deactivate'));
dom.btnModeBrowser.addEventListener('click', () => sendControl('mode', { mode: 'browser' }));
dom.btnModeNative.addEventListener('click', () => sendControl('mode', { mode: 'native' }));

dom.btnNativeStart.addEventListener('click', () => {
  const monitorIndex = Number(dom.selNativeMonitor.value || 0);
  sendControl('settings', { nativeMonitorIndex: monitorIndex });
  sendControl('nativeStart');
});
dom.btnNativeStop.addEventListener('click', () => sendControl('nativeStop'));

function pushSubtitleSettings() {
  sendControl('settings', {
    subtitlePosition: dom.selSubPosition.value,
    subtitleOpacity: Number(dom.rngOpacity.value) / 100,
    subtitleFontScale: Number(dom.rngFontScale.value) / 100,
    nativeMonitorIndex: Number(dom.selNativeMonitor.value || 0),
  });
}

dom.selSubPosition.addEventListener('change', pushSubtitleSettings);
dom.selNativeMonitor.addEventListener('change', pushSubtitleSettings);
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
  }
});

// Start
loadServerInfo();
loadMonitors();
refreshList();
pollLoop();
