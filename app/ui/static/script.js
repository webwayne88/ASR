const defaultApiBase = window.location.origin || 'http://127.0.0.1:8000';
const API_BASE = window.API_BASE || defaultApiBase;
const WS_BASE = API_BASE.startsWith('https')
  ? API_BASE.replace('https', 'wss')
  : API_BASE.replace('http', 'ws');
const SUPPORTED_AUDIO_MIME = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg'];
const SUPPORTED_AUDIO_EXT = ['.wav', '.mp3', '.ogg'];

document.addEventListener('DOMContentLoaded', () => {
  window.app = new SPA();
});

class SPA {
  constructor() {
    this.currentPage = 'stream';
    this.navLinks = document.querySelectorAll('#mainNav a');
    this.notificationSystem = new NotificationSystem();
    this.init();
  }

  init() {
    this.bindEvents();
    initStreamPage();
    initUploadPage();
    initPromptPage();
    initSettingsPage();
  }

  bindEvents() {
    this.navLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const page = link.getAttribute('data-page');
        this.navigateTo(page);
      });
    });
  }

  navigateTo(page) {
    if (this.currentPage === page) return;
    this.navLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('data-page') === page);
    });
    document.getElementById(`${this.currentPage}Page`)?.classList.remove('active');
    document.getElementById(`${page}Page`)?.classList.add('active');
    this.currentPage = page;
  }
}

class NotificationSystem {
  constructor() {
    this.notification = document.getElementById('notification');
    this.notificationText = document.getElementById('notificationText');
  }

  show(message, type = 'success') {
    this.notificationText.textContent = message;
    this.notification.className = `notification ${type}`;
    this.notification.classList.add('show');
    setTimeout(() => this.hide(), 3500);
  }

  hide() {
    this.notification.classList.remove('show');
  }
}

function initStreamPage() {
  const toggleBtn = document.getElementById('streamToggleBtn');
  const toggleLabel = document.getElementById('streamToggleLabel');
  const statusEl = document.getElementById('streamStatus');
  const resultsEl = document.getElementById('streamResults');
  const notify = new NotificationSystem();

  let ws = null;
  let audioCtx = null;
  let processor = null;
  let source = null;
  let stream = null;
  let buffers = [];
  let accumulatedSamples = 0;
  let streaming = false;
  const SAMPLE_RATE = 48000;
  let chunkDurationMs = 2000;
  let chunkSampleTarget = Math.round((SAMPLE_RATE * chunkDurationMs) / 1000);
  syncChunkSettings();

  function setChunkDuration(value) {
    const coerced = typeof value === 'number' ? value : Number(value);
    if (!Number.isNaN(coerced) && coerced >= 250 && coerced <= 5000) {
      chunkDurationMs = coerced;
      chunkSampleTarget = Math.round((SAMPLE_RATE * chunkDurationMs) / 1000);
    }
  }

  function setToggleState(active) {
    streaming = active;
    if (active) {
      toggleBtn?.classList.add('active');
      toggleLabel.textContent = 'Остановить запись';
      toggleBtn?.setAttribute('aria-pressed', 'true');
    } else {
      toggleBtn?.classList.remove('active');
      toggleLabel.textContent = 'Начать запись';
      toggleBtn?.setAttribute('aria-pressed', 'false');
    }
  }

  function resetResults() {
    resultsEl.innerHTML = '';
  }

  function cleanupAudio() {
    try {
      processor?.disconnect();
      source?.disconnect();
      audioCtx?.close();
    } catch {
      /* ignore */
    }
    stream?.getTracks().forEach((track) => track.stop());
    audioCtx = null;
    processor = null;
    source = null;
    stream = null;
    buffers = [];
    accumulatedSamples = 0;
  }

  function flushBuffers() {
    if (!buffers.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    const merged = mergeBuffers(buffers, accumulatedSamples);
    buffers = [];
    accumulatedSamples = 0;
    const payload = encodeWAV(merged, SAMPLE_RATE);
    ws.send(payload);
  }

  async function syncChunkSettings() {
    try {
      const resp = await fetch(`${API_BASE}/runtime/settings`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (typeof data.stream_chunk_ms === 'number') {
        setChunkDuration(data.stream_chunk_ms);
      }
    } catch {
      /* ignore fetch errors */
    }
  }

  document.addEventListener('runtime:settings-loaded', (event) => {
    const chunkMs = event?.detail?.stream_chunk_ms;
    if (typeof chunkMs === 'number') {
      setChunkDuration(chunkMs);
    }
  });

  async function startStream() {
    if (streaming) return;
    resetResults();
    statusEl.textContent = 'Подключение...';

    ws = new WebSocket(`${WS_BASE}/transcribe/stream`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
        source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (!streaming) return;
          const channel = event.inputBuffer.getChannelData(0);
          buffers.push(new Float32Array(channel));
          accumulatedSamples += channel.length;
          if (accumulatedSamples >= chunkSampleTarget) {
            flushBuffers();
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        setToggleState(true);
        statusEl.textContent = 'Идёт потоковая запись...';
      } catch (error) {
        notify.show('Нет доступа к микрофону', 'error');
        stopStream(true);
      }
    };

    ws.onerror = () => notify.show('Ошибка WebSocket соединения', 'error');

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'partial') {
          appendStreamRow(resultsEl, data, 'partial');
        } else if (data.event === 'summary') {
          appendStreamRow(resultsEl, { summary: data.summary }, 'final');
          statusEl.textContent = 'Поток остановлен';
        } else if (data.event === 'error') {
          notify.show(data.detail || 'Ошибка обработки', 'error');
        } else if (data.event === 'info') {
          appendStreamRow(resultsEl, { text: data.message }, 'info');
        }
      } catch (error) {
        console.warn('Не удалось обработать сообщение WS', error);
      }
    };

    ws.onclose = () => {
      stopStream(true);
    };
  }

  function stopStream(silent = false) {
    if (!streaming && silent) {
      cleanupAudio();
      ws = null;
      return;
    }
    flushBuffers();
    setToggleState(false);
    statusEl.textContent = 'Остановлено';
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'finalize' }));
      }
    } catch {
      /* ignore */
    }
    ws?.close();
    ws = null;
    cleanupAudio();
  }

  toggleBtn?.addEventListener('click', () => {
    if (streaming) {
      stopStream(false);
    } else {
      startStream();
    }
  });
}

function initUploadPage() {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const uploadBtn = document.getElementById('uploadSubmit');
  const fileInfo = document.getElementById('fileList');
  const results = document.getElementById('uploadResults');
  const notify = new NotificationSystem();

  let selectedFile = null;

  function describeFile(file) {
    fileInfo.innerHTML = `<div class="file-pill">${file.name} (${(file.size / 1024).toFixed(1)} KB)</div>`;
  }

  async function uploadSelected() {
    if (!selectedFile) {
      notify.show('Сначала выберите аудиофайл', 'error');
      return;
    }
    const form = new FormData();
    form.append('file', selectedFile);
    uploadBtn.disabled = true;
    results.textContent = 'Загрузка и обработка...';
    try {
      const resp = await fetch(`${API_BASE}/process_audio`, { method: 'POST', body: form });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      const links = [];
      if (data.json_url) links.push(`<a href="${data.json_url}" target="_blank">JSON</a>`);
      if (data.docx_url) links.push(`<a href="${data.docx_url}" target="_blank">DOCX</a>`);
      results.innerHTML = `
        <div>Статус: ${data.status}</div>
        ${data.summary ? `<div>Краткий итог: ${data.summary}</div>` : ''}
        ${links.length ? `<div>Скачать: ${links.join(' | ')}</div>` : ''}
      `;
      notify.show('Файл обработан', 'success');
    } catch (error) {
      console.error(error);
      notify.show('Ошибка обработки файла', 'error');
      results.textContent = 'Не удалось обработать файл.';
    } finally {
      uploadBtn.disabled = false;
    }
  }

  function handleSelection(files) {
    if (!files || !files.length) return;
    const file = files[0];
    const ext = (file.name || '').toLowerCase();
    const extOk = SUPPORTED_AUDIO_EXT.some((suffix) => ext.endsWith(suffix));
    const mimeOk = file.type ? SUPPORTED_AUDIO_MIME.includes(file.type) : false;
    if (!extOk && !mimeOk) {
      notify.show('Поддерживаются только WAV/MP3/OGG', 'error');
      return;
    }
    selectedFile = file;
    describeFile(file);
    results.textContent = '';
  }

  uploadArea?.addEventListener('dragover', (event) => {
    event.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea?.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea?.addEventListener('drop', (event) => {
    event.preventDefault();
    uploadArea.classList.remove('dragover');
    handleSelection(event.dataTransfer.files);
  });

  browseBtn?.addEventListener('click', () => fileInput?.click());
  uploadArea?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (event) => handleSelection(event.target.files));
  uploadBtn?.addEventListener('click', uploadSelected);
}

function initPromptPage() {
  const promptInput = document.getElementById('promptInput');
  const saveBtn = document.getElementById('saveBtn');
  const addBtn = document.getElementById('addPromptBtn');
  const newKeyInput = document.getElementById('newPromptKey');
  const listEl = document.getElementById('promptList');
  const notify = new NotificationSystem();

  let prompts = {};
  let currentKey = null;

  function stringifyPrompt(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      console.warn('Не удалось преобразовать промпт к строке', error);
      return value == null ? '' : String(value);
    }
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const keys = Object.keys(prompts);
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'prompt-empty';
      empty.textContent = 'Пока нет сохранённых промптов';
      listEl.appendChild(empty);
      return;
    }
    keys.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `prompt-btn${key === currentKey ? ' active' : ''}`;
      btn.textContent = key;
      btn.addEventListener('click', () => setActivePrompt(key));
      listEl.appendChild(btn);
    });
  }

  function setActivePrompt(key) {
    if (!promptInput) return;
    if (!key || !(key in prompts)) {
      currentKey = null;
      promptInput.value = '';
      promptInput.disabled = true;
      renderList();
      return;
    }
    promptInput.disabled = false;
    currentKey = key;
    promptInput.value = stringifyPrompt(prompts[key]);
    renderList();
  }

  promptInput?.addEventListener('input', () => {
    if (currentKey) {
      prompts[currentKey] = promptInput.value;
    }
  });

  async function loadPrompts() {
    try {
      const resp = await fetch(`${API_BASE}/prompts`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      prompts = data && typeof data === 'object' ? data : {};
      const keys = Object.keys(prompts);
      const first = currentKey && prompts[currentKey] !== undefined ? currentKey : keys[0];
      setActivePrompt(first);
    } catch (error) {
      console.error(error);
      notify.show('Не удалось загрузить промпты', 'error');
    }
  }

  saveBtn?.addEventListener('click', async () => {
    if (!currentKey) {
      notify.show('Выберите промпт для изменения', 'error');
      return;
    }
    prompts[currentKey] = promptInput.value || '';
    try {
      const resp = await fetch(`${API_BASE}/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prompts),
      });
      if (!resp.ok) throw new Error(await resp.text());
      notify.show('Промпты сохранены', 'success');
      loadPrompts();
    } catch (error) {
      console.error(error);
      notify.show('Ошибка сохранения промпта', 'error');
    }
  });

  addBtn?.addEventListener('click', () => {
    const key = (newKeyInput?.value || '').trim();
    if (!key) {
      notify.show('Введите название промпта', 'error');
      return;
    }
    if (prompts[key]) {
      notify.show('Такой промпт уже существует', 'error');
      return;
    }
    prompts[key] = '';
    newKeyInput.value = '';
    setActivePrompt(key);
  });

  loadPrompts();
}

function initSettingsPage() {
  const deviceSelect = document.getElementById('deviceSelect');
  const modelSelect = document.getElementById('modelSelect');
  const saveRuntimeBtn = document.getElementById('saveRuntimeSettings');
  const statusBar = document.getElementById('runtimeStatus');
  const processorToggle = document.getElementById('processorToggle');
  const diarizationToggle = document.getElementById('diarizationToggle');
  const chunkInput = document.getElementById('chunkInput');
  const pathsContainer = document.getElementById('pathsStatus');
  const notify = new NotificationSystem();
  let availableDevices = [];

  function renderPathStatuses(statuses = {}) {
    if (!pathsContainer) return;
    pathsContainer.innerHTML = '';
    Object.entries(statuses).forEach(([key, info]) => {
      const row = document.createElement('div');
      row.className = 'path-row';
      const statusLabel = info.exists
        ? info.writable
          ? 'доступно'
          : 'только чтение'
        : 'недоступно';
      row.innerHTML = `<strong>${key}:</strong> ${info.path} (${statusLabel}${
        info.free_gb != null ? `, свободно ${info.free_gb} ГБ` : ''
      })`;
      pathsContainer.appendChild(row);
    });
  }

  async function loadRuntimeSettings() {
    try {
      const resp = await fetch(`${API_BASE}/runtime/settings`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      availableDevices = data.available_devices || ['cpu'];
      if (deviceSelect) {
        deviceSelect.innerHTML = '';
        availableDevices.forEach((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value.toUpperCase();
          deviceSelect.appendChild(option);
        });
        deviceSelect.value = data.device || 'cpu';
      }

      if (modelSelect) {
        modelSelect.innerHTML = '';
        (data.available_models || [data.asr_model]).forEach((model) => {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          modelSelect.appendChild(option);
        });
        modelSelect.value = data.asr_model || modelSelect.options[0]?.value;
      }

      if (processorToggle) {
        const gpuSupported = availableDevices.includes('gpu');
        processorToggle.checked = (data.device || 'cpu') === 'gpu';
        processorToggle.disabled = !gpuSupported;
        processorToggle.title = gpuSupported ? '' : 'GPU недоступен в текущей конфигурации';
      }

      if (diarizationToggle) {
        diarizationToggle.checked = Boolean(data.diarization_enabled);
      }

      if (chunkInput && typeof data.stream_chunk_ms === 'number') {
        chunkInput.value = data.stream_chunk_ms;
      }

      document.dispatchEvent(new CustomEvent('runtime:settings-loaded', { detail: data }));
    } catch (error) {
      console.error(error);
      notify.show('Не удалось получить настройки', 'error');
    }
  }

  async function loadPathStatus() {
    try {
      const resp = await fetch(`${API_BASE}/runtime/paths`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      renderPathStatuses(data);
    } catch (error) {
      console.error(error);
      notify.show('Не удалось получить информацию о каталогах', 'error');
    }
  }

  saveRuntimeBtn?.addEventListener('click', async () => {
    const payload = {
      device: deviceSelect?.value,
      asr_model: modelSelect?.value,
    };
    if (diarizationToggle) {
      payload.diarization_enabled = diarizationToggle.checked;
    }
    if (chunkInput && chunkInput.value) {
      payload.stream_chunk_ms = Number(chunkInput.value);
    }
    try {
      const resp = await fetch(`${API_BASE}/runtime/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(await resp.text());
      statusBar.textContent = 'Настройки сохранены и применены';
      notify.show('Настройки обновлены', 'success');
      await loadRuntimeSettings();
      await loadPathStatus();
    } catch (error) {
      console.error(error);
      notify.show('Не удалось сохранить настройки', 'error');
    }
  });

  deviceSelect?.addEventListener('change', () => {
    if (processorToggle) {
      processorToggle.checked = deviceSelect.value === 'gpu';
    }
  });

  processorToggle?.addEventListener('change', () => {
    if (!processorToggle || !deviceSelect) return;
    if (!processorToggle.checked) {
      deviceSelect.value = 'cpu';
      return;
    }
    const gpuAllowed = Array.from(deviceSelect.options).some((option) => option.value === 'gpu');
    if (gpuAllowed) {
      deviceSelect.value = 'gpu';
      return;
    }
    processorToggle.checked = false;
    notify.show('GPU недоступен на этой машине', 'error');
  });

  loadRuntimeSettings();
  loadPathStatus();
}

function mergeBuffers(buffers, totalLength) {
  const result = new Float32Array(totalLength);
  let offset = 0;
  buffers.forEach((buffer) => {
    result.set(buffer, offset);
    offset += buffer.length;
  });
  return result;
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const numChannels = 1;
  const bitsPerSample = 16;

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i += 1) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true);
  view.setUint16(32, (numChannels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function formatTime(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '';
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}`;
}

function appendStreamRow(container, payload, type = 'partial') {
  if (!container) return;
  const row = document.createElement('div');
  row.className = `stream-row stream-row-${type}`;
  const start = typeof payload.start === 'number' ? formatTime(payload.start) : null;
  const end = typeof payload.end === 'number' ? formatTime(payload.end) : null;
  const prefix = start && end ? `[${start} – ${end}] ` : '';
  const content = payload.text || payload.summary || '';
  row.textContent = `${prefix}${content || '(пусто)'}`;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}
