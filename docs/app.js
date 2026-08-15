import { decodeBase64Url, driftExceeds, formatTime, gainFromDecibels, interpolateAlignment, noteSummary, pairedTimes } from './lib/core.js';

const VERSION_LABELS = { original: 'Original', mejorado: 'Mejorado' };
const OTHER_TAKE = { 5016: '5017', 5017: '5016' };
const STORAGE_KEY = 'elisa-audio-key';
const NOTES_KEY = 'elisa-audio-notes-v1';

class TakePlayer {
  constructor(app, take, card) {
    this.app = app;
    this.take = take;
    this.card = card;
    this.version = 'original';
    this.loaded = false;
    this.loading = null;
    this.playing = false;
    this.pendingEquivalent = null;
    this.audios = {};
    this.sources = {};
    this.gains = {};
    this.urls = [];
    this.status = card.querySelector('[data-role="status"]');
    this.currentOutput = card.querySelector('[data-role="current"]');
    this.durationOutput = card.querySelector('[data-role="duration"]');
    this.timeline = card.querySelector('[data-role="timeline"]');
    this.canvas = card.querySelector('[data-role="waveform"]');
    this.ghost = card.querySelector('[data-role="ghost"]');
    this.equivalentText = card.querySelector('[data-role="equivalent-text"]');
    this.switchButton = card.querySelector('[data-action="switch-take"]');
    this.playButton = card.querySelector('[data-action="play"]');
    this.progress = card.querySelector('[data-role="load"]');
    this.duration = app.manifest.takes[take].versions.original.duration;
    this.offset = app.manifest.takes[take].abOffset.seconds;
    this.timeline.max = this.duration;
    this.durationOutput.value = formatTime(this.duration);
    this.bind();
    this.renderMarkers();
    this.drawWaveform();
  }

  bind() {
    this.card.querySelectorAll('[data-version]').forEach((button) => {
      button.addEventListener('click', async () => {
        await this.ensureLoaded();
        this.setVersion(button.dataset.version);
        this.app.lastActive = this;
      });
    });
    this.playButton.addEventListener('click', () => this.toggle());
    this.card.querySelector('[data-action="back"]').addEventListener('click', async () => {
      await this.ensureLoaded(); this.seek(this.time() - 5); this.app.lastActive = this;
    });
    this.card.querySelector('[data-action="forward"]').addEventListener('click', async () => {
      await this.ensureLoaded(); this.seek(this.time() + 5); this.app.lastActive = this;
    });
    this.timeline.addEventListener('input', async () => {
      await this.ensureLoaded(); this.seek(Number(this.timeline.value)); this.app.lastActive = this;
    });
    this.switchButton.addEventListener('click', () => {
      if (this.pendingEquivalent?.available) this.app.switchTake(this, this.pendingEquivalent.time);
    });
  }

  async ensureLoaded() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.load().catch((error) => {
      this.loading = null;
      this.status.textContent = 'No se pudo abrir';
      this.app.showKeyError(error);
      throw error;
    });
    return this.loading;
  }

  async load() {
    this.status.textContent = 'Cargando audio…';
    const versions = ['original', 'mejorado'];
    for (let index = 0; index < versions.length; index += 1) {
      const version = versions[index];
      const meta = this.app.manifest.takes[this.take].versions[version];
      const blob = await this.app.decryptAudio(meta, (fraction) => {
        this.progress.style.setProperty('--progress', `${((index + fraction) / 2) * 100}%`);
      });
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      audio.src = url;
      await new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(new Error(`El navegador no pudo leer ${version}`)), { once: true });
      });
      this.audios[version] = audio;
      const source = this.app.audioContext.createMediaElementSource(audio);
      const gain = this.app.audioContext.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.app.audioContext.destination);
      this.sources[version] = source;
      this.gains[version] = gain;
    }
    this.audios.original.addEventListener('ended', () => this.pause());
    this.loaded = true;
    this.loading = null;
    this.progress.style.setProperty('--progress', '100%');
    this.progress.classList.add('done');
    this.status.textContent = 'Lista para escuchar';
    this.applyGains(false);
    this.seek(Number(this.timeline.value));
  }

  time() {
    if (!this.loaded) return Number(this.timeline.value) || 0;
    const value = this.version === 'original'
      ? this.audios.original.currentTime
      : this.audios.mejorado.currentTime - this.offset;
    return Math.max(0, Math.min(this.duration, value));
  }

  seek(seconds) {
    const time = Math.max(0, Math.min(this.duration, Number(seconds) || 0));
    if (this.loaded) {
      const pair = pairedTimes(time, this.offset, {
        original: this.audios.original.duration || this.duration,
        mejorado: this.audios.mejorado.duration || this.duration,
      });
      this.audios.original.currentTime = pair.original;
      this.audios.mejorado.currentTime = pair.mejorado;
    }
    this.timeline.value = time;
    this.currentOutput.value = formatTime(time);
    this.drawWaveform(time);
    this.app.updateEquivalent(this);
  }

  async toggle() {
    // Reanudar durante el gesto es importante en Safari, incluso si aún falta
    // descargar y descifrar una toma diferida.
    await this.app.audioContext.resume();
    try {
      await this.ensureLoaded();
      if (this.playing) this.pause(); else await this.play();
    } catch (error) {
      this.pause();
      if (error?.name === 'NotAllowedError') this.status.textContent = 'Toca reproducir de nuevo';
    }
  }

  async play() {
    await this.ensureLoaded();
    await this.app.activate(this);
    if (this.time() >= this.duration - 0.1) this.seek(0);
    const promises = Object.values(this.audios).map((audio) => audio.play());
    await Promise.all(promises);
    this.playing = true;
    this.playButton.classList.add('is-playing');
    this.playButton.innerHTML = '<span aria-hidden="true">Ⅱ</span>';
    this.playButton.setAttribute('aria-label', 'Pausar');
    this.status.textContent = `Sonando · ${VERSION_LABELS[this.version]}`;
    this.app.lastActive = this;
    this.startClock();
  }

  pause() {
    if (this.loaded) Object.values(this.audios).forEach((audio) => audio.pause());
    this.playing = false;
    this.playButton.classList.remove('is-playing');
    this.playButton.innerHTML = '<span aria-hidden="true">▶</span>';
    this.playButton.setAttribute('aria-label', 'Reproducir');
    if (this.loaded) this.status.textContent = 'En pausa';
    cancelAnimationFrame(this.frame);
  }

  startClock() {
    cancelAnimationFrame(this.frame);
    let lastSync = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      const time = this.time();
      this.timeline.value = time;
      this.currentOutput.value = formatTime(time);
      this.drawWaveform(time);
      this.app.updateEquivalent(this);
      if (now - lastSync > 500) {
        this.correctDrift();
        lastSync = now;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  correctDrift() {
    const expectedImproved = this.audios.original.currentTime + this.offset;
    if (driftExceeds(this.audios.mejorado.currentTime, expectedImproved)) {
      this.audios.mejorado.currentTime = Math.max(0, expectedImproved);
    }
  }

  setVersion(version) {
    if (!VERSION_LABELS[version] || version === this.version) return;
    if (this.loaded) this.seek(this.time());
    this.version = version;
    this.card.querySelectorAll('[data-version]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.version === version));
    });
    this.applyGains(true);
    this.drawWaveform();
    if (this.playing) this.status.textContent = `Sonando · ${VERSION_LABELS[version]}`;
  }

  applyGains(crossfade = true) {
    if (!this.loaded) return;
    const now = this.app.audioContext.currentTime;
    for (const version of ['original', 'mejorado']) {
      const node = this.gains[version].gain;
      const decibels = this.app.volumeMatch
        ? this.app.manifest.takes[this.take].versions[version].matchGainDb
        : 0;
      const target = version === this.version ? gainFromDecibels(decibels) : 0;
      node.cancelScheduledValues(now);
      node.setValueAtTime(node.value, now);
      if (crossfade) node.linearRampToValueAtTime(target, now + 0.02);
      else node.setValueAtTime(target, now);
    }
  }

  drawWaveform(time = this.time()) {
    const peaks = this.app.waveforms.takes[this.take].versions[this.version];
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const height = Math.round(48 * devicePixelRatio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(this.card);
    const played = Math.max(0, Math.min(1, time / this.duration));
    const middle = height / 2;
    const step = width / peaks.length;
    for (let index = 0; index < peaks.length; index += 1) {
      const amplitude = Math.max(1, peaks[index] * (height * 0.44));
      context.fillStyle = index / peaks.length <= played ? styles.getPropertyValue('--accent') : '#b8b2a8';
      context.fillRect(index * step, middle - amplitude, Math.max(1, step * 0.72), amplitude * 2);
    }
  }

  renderMarkers() {
    const container = this.card.querySelector('[data-role="markers"]');
    for (const marker of this.app.alignment.markers) {
      const time = marker[`t${this.take}`];
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${marker.label} · ${formatTime(time)}`;
      button.title = `Ir a ${marker.label}`;
      button.addEventListener('click', async () => {
        await this.ensureLoaded(); this.seek(time); this.app.lastActive = this;
      });
      container.append(button);
    }
  }

  showGhost(time) {
    if (!Number.isFinite(time)) { this.ghost.hidden = true; return; }
    this.ghost.hidden = false;
    this.ghost.style.setProperty('--ghost-left', `${Math.max(0, Math.min(100, time / this.duration * 100))}%`);
  }

  dispose() {
    this.pause();
    this.urls.forEach((url) => URL.revokeObjectURL(url));
  }
}

class AudioComparator {
  async init() {
    [this.manifest, this.alignment, this.waveforms] = await Promise.all([
      this.getJson('./assets/manifest.json'),
      this.getJson('./data/alignment.json'),
      this.getJson('./data/waveforms.json'),
    ]);
    this.volumeMatch = true;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const keyValue = this.readKey();
    if (!keyValue) {
      this.showKeyError(new Error('Abre el enlace privado completo que te han enviado. Falta la clave de acceso.'));
      return;
    }
    try {
      const raw = decodeBase64Url(keyValue);
      if (raw.length !== 32) throw new Error('La clave del enlace no es válida.');
      this.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      sessionStorage.setItem(STORAGE_KEY, keyValue);
      if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (error) {
      sessionStorage.removeItem(STORAGE_KEY);
      this.showKeyError(error);
      return;
    }
    document.querySelector('#players').hidden = false;
    document.querySelector('#notes').hidden = false;
    this.players = new Map(
      [...document.querySelectorAll('.player-card')].map((card) => {
        const player = new TakePlayer(this, card.dataset.take, card);
        return [card.dataset.take, player];
      }),
    );
    this.lastActive = this.players.get('5016');
    this.bindGlobal();
    this.setupNotes();
    try {
      await this.lastActive.ensureLoaded();
    } catch { /* El mensaje amable ya está visible. */ }
  }

  async getJson(url) {
    const response = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`No se pudo cargar ${url}`);
    return response.json();
  }

  readKey() {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('key');
    return fragment || sessionStorage.getItem(STORAGE_KEY);
  }

  async decryptAudio(meta, onProgress) {
    const response = await fetch(`./${meta.file}`, { cache: 'force-cache', referrerPolicy: 'no-referrer' });
    if (!response.ok || !response.body) throw new Error('No se pudo descargar el audio cifrado.');
    const total = Number(response.headers.get('content-length')) || meta.encryptedBytes;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length; onProgress(received / total);
    }
    const encrypted = new Uint8Array(received);
    let cursor = 0;
    for (const chunk of chunks) { encrypted.set(chunk, cursor); cursor += chunk.length; }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decodeBase64Url(meta.iv) }, this.key, encrypted,
      );
      onProgress(1);
      return new Blob([plain], { type: meta.mime });
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
      throw new Error('La clave del enlace no es correcta o el audio está dañado. Pide un enlace nuevo.');
    }
  }

  async activate(player) {
    await this.audioContext.resume();
    for (const other of this.players.values()) {
      if (other !== player && other.playing) other.pause();
    }
  }

  async switchTake(source, targetTime) {
    await this.audioContext.resume();
    const wasPlaying = source.playing;
    const target = this.players.get(OTHER_TAKE[source.take]);
    const version = source.version;
    source.pause();
    try {
      await target.ensureLoaded();
      target.setVersion(version);
      target.seek(targetTime);
      this.lastActive = target;
      target.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (wasPlaying) await target.play();
    } catch (error) {
      if (target.loaded && error?.name === 'NotAllowedError') {
        target.status.textContent = 'Lista · toca reproducir para continuar';
      }
    }
  }

  updateEquivalent(source) {
    const result = interpolateAlignment(this.alignment, source.take, source.time());
    source.pendingEquivalent = result;
    const otherTake = OTHER_TAKE[source.take];
    const target = this.players.get(otherTake);
    for (const player of this.players.values()) if (player !== target) player.showGhost(undefined);
    if (!result.available) {
      source.equivalentText.textContent = `Sin salto seguro: ${result.reason}.`;
      source.switchButton.disabled = true;
      target?.showGhost(undefined);
      return;
    }
    const caveat = result.fallback ? ` (usando ${result.marker}, el punto fiable más cercano)` : '';
    source.equivalentText.textContent = `Punto aproximado en la otra toma: ${formatTime(result.time)}${caveat}.`;
    source.switchButton.disabled = false;
    target?.showGhost(result.time);
  }

  showKeyError(error) {
    document.querySelector('#players').hidden = true;
    document.querySelector('#notes').hidden = true;
    const box = document.querySelector('#key-message');
    box.hidden = false;
    document.querySelector('#key-message-text').textContent = error.message || 'No se pudo descifrar el audio.';
  }

  bindGlobal() {
    document.querySelector('#volume-match').addEventListener('change', (event) => {
      this.volumeMatch = event.target.checked;
      this.players.forEach((player) => player.applyGains(true));
    });
    window.addEventListener('resize', () => this.players.forEach((player) => player.drawWaveform()));
    window.addEventListener('pagehide', () => this.players.forEach((player) => player.dispose()), { once: true });
    document.addEventListener('keydown', (event) => {
      if (['INPUT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(document.activeElement?.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); this.lastActive?.toggle(); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); this.lastActive?.seek(this.lastActive.time() - 5); }
      if (event.code === 'ArrowRight') { event.preventDefault(); this.lastActive?.seek(this.lastActive.time() + 5); }
    });
  }

  setupNotes() {
    const form = document.querySelector('#note-form');
    const text = document.querySelector('#note-text');
    const context = document.querySelector('#note-context');
    const feedback = document.querySelector('#note-feedback');
    try { this.notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch { this.notes = []; }
    let draft = null;
    const startDraft = (note = null) => {
      const player = note ? this.players.get(note.take) : this.lastActive;
      const time = note?.time ?? player.time();
      const mapped = interpolateAlignment(this.alignment, player.take, time);
      draft = note ? { ...note } : {
        id: crypto.randomUUID(), take: player.take, version: player.version, time,
        otherTake: OTHER_TAKE[player.take], equivalentTime: mapped.available ? mapped.time : null,
      };
      context.textContent = `Toma ${draft.take} · ${VERSION_LABELS[draft.version]} · ${formatTime(draft.time)}`;
      text.value = note?.text || '';
      form.hidden = false; text.focus();
    };
    document.querySelector('#mark-note').addEventListener('click', () => startDraft());
    document.querySelector('#cancel-note').addEventListener('click', () => { form.hidden = true; draft = null; });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = text.value.trim(); if (!value || !draft) return;
      const existing = this.notes.findIndex((note) => note.id === draft.id);
      const complete = { ...draft, text: value };
      if (existing >= 0) this.notes[existing] = complete; else this.notes.push(complete);
      this.saveNotes(); form.hidden = true; draft = null; this.renderNotes(startDraft);
    });
    document.querySelector('#copy-notes').addEventListener('click', async () => {
      const summary = this.notes.map(noteSummary).join('\n');
      if (!summary) { feedback.textContent = 'Aún no hay notas.'; return; }
      await navigator.clipboard.writeText(summary); feedback.textContent = 'Resumen copiado.';
    });
    document.querySelector('#download-notes').addEventListener('click', () => {
      const summary = this.notes.map(noteSummary).join('\n');
      if (!summary) { feedback.textContent = 'Aún no hay notas.'; return; }
      const url = URL.createObjectURL(new Blob([`${summary}\n`], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'notas-elisa.txt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); feedback.textContent = 'Resumen descargado.';
    });
    this.renderNotes(startDraft);
  }

  saveNotes() {
    localStorage.setItem(NOTES_KEY, JSON.stringify(this.notes));
  }

  renderNotes(startDraft) {
    const list = document.querySelector('#note-list'); list.replaceChildren();
    document.querySelector('#note-count').textContent = this.notes.length;
    for (const note of this.notes) {
      const item = document.createElement('li');
      const summary = document.createElement('p'); summary.textContent = noteSummary(note);
      const actions = document.createElement('div');
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Editar';
      edit.addEventListener('click', () => startDraft(note));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Eliminar';
      remove.addEventListener('click', () => {
        this.notes = this.notes.filter((candidate) => candidate.id !== note.id);
        this.saveNotes(); this.renderNotes(startDraft);
      });
      actions.append(edit, remove); item.append(summary, actions); list.append(item);
    }
  }
}

const app = new AudioComparator();
app.init().catch((error) => {
  const box = document.querySelector('#key-message');
  box.hidden = false;
  document.querySelector('#key-message-text').textContent = `No se pudo iniciar la página: ${error.message}`;
});
