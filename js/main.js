// UI の組み立て: 音声読み込み → 自動生成 → 編集 → 書き出し
import {
  NOTE, TPB, createChart, chartToTJA, parseTJA, chartStats, timeToTick, tickToTime, noteEndTick,
} from './chart.js';
import { DIFFICULTY_PRESETS, quantizeOnsets, refineTempo, estimateOffset } from './analysis.js';
import { ChartStore } from './store.js';
import { Player, computePeaks } from './player.js';
import { ChartEditor, TOOL } from './editor.js';

const STORAGE_KEY = 'taiko-chart-maker:chart';
const ANALYSIS_SAMPLE_RATE = 22050;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 通知
let toastTimer;
function toast(message, { error = false, duration = 3500 } = {}) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ---------------------------------------------------------------- 状態
const store = new ChartStore(loadSavedChart() || createChart());
const player = new Player();
player.getChart = () => store.chart;
const editor = new ChartEditor($('editor-canvas'), store, {
  onSeek: (t) => { player.seek(t); editor.setPlayhead(player.currentTime, player.playing); },
  onStatus: (msg) => toast(msg),
});

let audioBuffer = null;
let lastOnsets = null;   // 直近の解析で検出したオンセット（作り直し用）

function loadSavedChart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const chart = JSON.parse(raw);
    return chart && Array.isArray(chart.notes) ? { ...createChart(), ...chart, meta: { ...createChart().meta, ...chart.meta } } : null;
  } catch {
    return null;
  }
}

let saveTimer;
store.addEventListener('change', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store.chart)); } catch { /* 保存できない環境では無視 */ }
  }, 400);
  syncMetaForm();
  updateStats();
});

// ---------------------------------------------------------------- 解析オプション
const opt = {
  preset: $('opt-preset'),
  sensitivity: $('opt-sensitivity'),
  grid: $('opt-grid'),
  gap: $('opt-gap'),
  don: $('opt-don'),
  big: $('opt-big'),
  bpm: $('opt-bpm'),
};

function applyPreset(name) {
  const p = DIFFICULTY_PRESETS[name];
  opt.sensitivity.value = p.sensitivity;
  opt.grid.value = p.triplets ? '4t' : String(p.division);
  opt.gap.value = String(p.minGapTicks);
  opt.big.value = p.bigRatio;
  $('meta-course').value = { easy: 'Easy', normal: 'Normal', hard: 'Hard', oni: 'Oni' }[name];
  updateOptionLabels();
}

function updateOptionLabels() {
  $('opt-sensitivity-out').textContent = Math.round(opt.sensitivity.value * 100) + '%';
  $('opt-don-out').textContent = Math.round(opt.don.value * 100) + '%';
  $('opt-big-out').textContent = Math.round(opt.big.value * 100) + '%';
}

function getOptions() {
  const grid = opt.grid.value;
  const bpm = parseFloat(opt.bpm.value);
  return {
    sensitivity: parseFloat(opt.sensitivity.value),
    division: parseInt(grid, 10),
    triplets: grid.endsWith('t'),
    minGapTicks: parseInt(opt.gap.value, 10),
    donRatio: parseFloat(opt.don.value),
    bigRatio: parseFloat(opt.big.value),
    bpm: bpm > 0 ? bpm : null,
  };
}

opt.preset.addEventListener('change', () => applyPreset(opt.preset.value));
for (const el of [opt.sensitivity, opt.don, opt.big]) el.addEventListener('input', updateOptionLabels);
applyPreset(opt.preset.value);

// ---------------------------------------------------------------- 音声読み込み
async function loadAudioFile(file) {
  if (!file) return;
  $('audio-name').textContent = `読み込み中… ${file.name}`;
  try {
    const buffer = await player.decode(await file.arrayBuffer());
    audioBuffer = buffer;
    player.setBuffer(buffer);
    editor.setPeaks(computePeaks(buffer), buffer.duration);
    editor.setPlayhead(0, false);
    lastOnsets = null;
    editor.setOnsets([]);
    $('audio-name').textContent = `${file.name}（${formatTime(buffer.duration, false)}）`;
    $('analyze-btn').disabled = false;
    $('requantize-btn').disabled = true;
    $('analysis-result').hidden = true;
    store.updateQuietly((c) => {
      c.meta.wave = file.name;
      if (!c.meta.title) c.meta.title = file.name.replace(/\.[^.]+$/, '');
    });
    toast('音声を読み込みました。「自動で譜面を作る」で下書きを生成できます。');
  } catch (err) {
    $('audio-name').textContent = '未選択';
    toast(`音声を読み込めませんでした: ${err.message || err}`, { error: true });
  }
}

$('audio-input').addEventListener('change', (e) => loadAudioFile(e.target.files[0]));
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  loadAudioFile(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- 自動生成
async function toMono(buffer, sampleRate) {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * sampleRate)), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function runAnalysis(samples, sampleRate, options, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    const fallback = async () => {
      // モジュール Worker が使えない環境ではメインスレッドで実行する
      const { analyze } = await import('./analysis.js');
      try { resolve(analyze(samples, sampleRate, options, onProgress)); } catch (err) { reject(err); }
    };
    if (!worker) { fallback(); return; }
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.value);
      else {
        worker.terminate();
        if (msg.type === 'result') resolve(msg.result);
        else reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      fallback();
    };
    worker.postMessage({ samples, sampleRate, options }, [samples.buffer]);
  });
}

$('analyze-btn').addEventListener('click', async () => {
  if (!audioBuffer) return;
  if (store.chart.notes.length && !confirm('現在の譜面を自動生成の結果で置き換えます（元に戻す で復元できます）。よろしいですか？')) return;
  const btn = $('analyze-btn');
  const progress = $('analyze-progress');
  btn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  try {
    const samples = new Float32Array(await toMono(audioBuffer, ANALYSIS_SAMPLE_RATE));
    const result = await runAnalysis(samples, ANALYSIS_SAMPLE_RATE, getOptions(), (v) => { progress.value = v; });
    lastOnsets = result.onsets;
    editor.setOnsets(result.onsets);
    store.mutate((c) => {
      c.bpm = result.bpm;
      c.offset = result.offset;
      c.notes = result.notes;
      c.meta.course = $('meta-course').value;
    });
    showAnalysisResult(result.bpm, result.candidates);
    $('requantize-btn').disabled = false;
    editor.revealTime(Math.max(0, result.offset));
    toast(`${result.notes.length} 個の音符を生成しました（BPM ${result.bpm}）。\nBPM がずれている場合は候補や ×2 / ÷2 を試してください。`, { duration: 6000 });
  } catch (err) {
    toast(`解析に失敗しました: ${err.message || err}`, { error: true });
  } finally {
    btn.disabled = false;
    progress.hidden = true;
  }
});

function showAnalysisResult(bpm, candidates = []) {
  $('analysis-result').hidden = false;
  $('result-bpm').textContent = bpm;
  const box = $('result-candidates');
  box.textContent = '';
  for (const c of candidates) {
    if (Math.abs(c.bpm - bpm) < 0.5) continue;
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = c.bpm.toFixed(1);
    b.title = 'この BPM で作り直す';
    b.addEventListener('click', () => retempo(c.bpm, true));
    box.append(b);
  }
  if (!box.childElementCount) box.textContent = 'なし';
}

/** BPM を変更する。検出済みのオンセットがあれば位相も推定し直して譜面を作り直す。 */
function retempo(bpm, refine) {
  if (!(bpm > 0)) return;
  if (lastOnsets && lastOnsets.length) {
    const newBpm = refine ? refineTempo(lastOnsets, bpm) : bpm;
    const offset = estimateOffset(lastOnsets, newBpm);
    store.mutate((c) => {
      c.bpm = newBpm;
      c.offset = offset;
      c.notes = quantizeOnsets(lastOnsets, newBpm, offset, getOptions());
    });
    showAnalysisResult(newBpm, []);
    toast(`BPM ${newBpm} で作り直しました`);
  } else {
    // 手入力の譜面: 音符の時刻を保ったまま BPM だけ変える
    const ratio = bpm / store.chart.bpm;
    store.mutate((c) => {
      c.bpm = bpm;
      c.notes = c.notes.map((n) => ({ ...n, tick: Math.round(n.tick * ratio), ...(n.len ? { len: Math.max(1, Math.round(n.len * ratio)) } : {}) }));
    });
  }
}

$('bpm-double').addEventListener('click', () => retempo(store.chart.bpm * 2, false));
$('bpm-half').addEventListener('click', () => retempo(store.chart.bpm / 2, false));
$('requantize-btn').addEventListener('click', () => {
  if (!lastOnsets) return;
  if (store.chart.notes.length && !confirm('手で編集した内容は失われます（元に戻す で復元できます）。作り直しますか？')) return;
  store.mutate((c) => { c.notes = quantizeOnsets(lastOnsets, c.bpm, c.offset, getOptions()); });
  toast(`${store.chart.notes.length} 個の音符で作り直しました`);
});

// ---------------------------------------------------------------- ツールバー
const toolButtons = [...document.querySelectorAll('#toolbar [data-tool]')];
function setTool(tool) {
  editor.setTool(tool);
  for (const b of toolButtons) {
    const t = /^\d$/.test(b.dataset.tool) ? Number(b.dataset.tool) : b.dataset.tool;
    b.classList.toggle('active', t === tool);
  }
}
for (const b of toolButtons) {
  b.addEventListener('click', () => setTool(/^\d$/.test(b.dataset.tool) ? Number(b.dataset.tool) : b.dataset.tool));
}
setTool(NOTE.DON);

$('snap').addEventListener('change', (e) => editor.setSnap(Number(e.target.value)));
editor.setSnap(Number($('snap').value));
$('zoom-in').addEventListener('click', () => editor.zoom(1.25));
$('zoom-out').addEventListener('click', () => editor.zoom(0.8));
$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
$('show-onsets').addEventListener('change', (e) => { editor.showOnsets = e.target.checked; editor.invalidate(); });

// ---------------------------------------------------------------- 再生
function togglePlay() {
  if (player.playing) player.pause();
  else {
    if (player.buffer && player.currentTime >= player.duration - 0.01) player.seek(0);
    player.play();
  }
  updatePlayButton();
}
function updatePlayButton() {
  $('play-btn').textContent = player.playing ? '❚❚ 停止' : '▶ 再生';
}
player.onEnded = updatePlayButton;

$('play-btn').addEventListener('click', togglePlay);
$('rewind-btn').addEventListener('click', () => { player.seek(0); editor.setPlayhead(0, false); editor.revealTime(0); });
$('rate').addEventListener('change', (e) => player.setRate(Number(e.target.value)));
$('music-vol').addEventListener('input', (e) => player.setMusicVolume(Number(e.target.value)));
$('se-vol').addEventListener('input', (e) => player.setSeVolume(Number(e.target.value)));
$('hit-sounds').addEventListener('change', (e) => { player.hitSounds = e.target.checked; });
$('metronome').addEventListener('change', (e) => { player.metronome = e.target.checked; });
$('follow').addEventListener('change', (e) => { editor.follow = e.target.checked; });

let recording = false;
$('record-btn').addEventListener('click', () => {
  recording = !recording;
  $('record-btn').classList.toggle('active', recording);
  if (recording) toast('リアルタイム入力: 再生中に F/J でドン、D/K でカッ（同時押しで大音符）。\n記録位置はスナップ設定に合わせて丸められます。', { duration: 6000 });
});

function formatTime(t, ms = true) {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${m}:${ms ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}

function frame() {
  const t = player.currentTime;
  if (player.playing || editor.playhead !== t) editor.setPlayhead(t, player.playing);
  const beat = timeToTick(store.chart, t) / TPB;
  $('time-display').textContent = `${formatTime(t)}  ${beat >= 0 ? `${Math.floor(beat / 4) + 1}:${Math.floor(beat % 4) + 1}` : ''}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- キーボード
let lastRecorded = null;
function recordHit(kind, key) {
  const time = player.currentTime - Number($('input-offset').value || 0) / 1000;
  const now = performance.now();
  player.hit(kind === 'don' ? NOTE.DON : NOTE.KA);
  // 反対側のキーとほぼ同時に押したら大音符にする
  if (lastRecorded && lastRecorded.kind === kind && lastRecorded.key !== key && now - lastRecorded.at < 60) {
    const tick = lastRecorded.tick;
    store.mutate((c) => {
      const n = c.notes.find((m) => m.tick === tick);
      if (n) n.type = kind === 'don' ? NOTE.BIG_DON : NOTE.BIG_KA;
    });
    lastRecorded = null;
    return;
  }
  const tick = editor.placeAtTime(time, kind === 'don' ? NOTE.DON : NOTE.KA);
  lastRecorded = { kind, key, at: now, tick };
}

const SWAP_COLOR = { 1: 2, 2: 1, 3: 4, 4: 3 };
const SWAP_SIZE = { 1: 3, 3: 1, 2: 4, 4: 2 };

document.addEventListener('keydown', (e) => {
  const target = e.target;
  if (target.matches('input[type="text"], input[type="number"], textarea, select')) return;
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  if (mod) {
    if (key === 'z' && !e.shiftKey) store.undo();
    else if (key === 'y' || (key === 'z' && e.shiftKey)) store.redo();
    else if (key === 'a') editor.selectAll();
    else if (key === 'c') editor.copySelection();
    else if (key === 'v') editor.paste(player.currentTime);
    else return;
    e.preventDefault();
    return;
  }

  if (recording && player.playing && ['f', 'j', 'd', 'k'].includes(key)) {
    if (!e.repeat) recordHit(key === 'f' || key === 'j' ? 'don' : 'ka', key);
    e.preventDefault();
    return;
  }

  switch (key) {
    case ' ':
      togglePlay();
      break;
    case '1': case '2': case '3': case '4': case '5': case '6':
      setTool(Number(key));
      break;
    case 'v':
      setTool(TOOL.SELECT);
      break;
    case 'e':
      setTool(TOOL.ERASER);
      break;
    case 'r':
      editor.transformSelection((t) => SWAP_COLOR[t] ?? t);
      break;
    case 'b':
      editor.transformSelection((t) => SWAP_SIZE[t] ?? t);
      break;
    case 'delete':
    case 'backspace':
      editor.deleteSelection();
      break;
    case 'escape':
      editor.clearSelection();
      break;
    case 'arrowleft':
    case 'arrowright': {
      const dir = key === 'arrowleft' ? -1 : 1;
      if (!editor.moveSelection(dir * editor.snap)) {
        const t = Math.max(0, player.currentTime + (dir * 60) / store.chart.bpm);
        player.seek(t);
        editor.setPlayhead(t, player.playing);
        editor.revealTime(t);
      }
      break;
    }
    case 'home':
      player.seek(0);
      editor.setPlayhead(0, false);
      editor.revealTime(0);
      break;
    case '+':
    case '=':
      editor.zoom(1.25);
      break;
    case '-':
      editor.zoom(0.8);
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------- 曲情報
const meta = {
  title: $('meta-title'),
  subtitle: $('meta-subtitle'),
  bpm: $('meta-bpm'),
  offset: $('meta-offset'),
  course: $('meta-course'),
  level: $('meta-level'),
  wave: $('meta-wave'),
  demostart: $('meta-demostart'),
};

function syncMetaForm() {
  const c = store.chart;
  const set = (el, v) => { if (document.activeElement !== el) el.value = v; };
  set(meta.title, c.meta.title);
  set(meta.subtitle, c.meta.subtitle);
  set(meta.bpm, c.bpm);
  set(meta.offset, c.offset);
  set(meta.course, c.meta.course);
  set(meta.level, c.meta.level);
  set(meta.wave, c.meta.wave);
  set(meta.demostart, c.meta.demostart);
}

for (const key of ['title', 'subtitle', 'wave']) {
  meta[key].addEventListener('input', () => store.updateQuietly((c) => { c.meta[key] = meta[key].value; }));
}
meta.course.addEventListener('change', () => store.updateQuietly((c) => { c.meta.course = meta.course.value; }));
meta.level.addEventListener('change', () => store.updateQuietly((c) => { c.meta.level = parseInt(meta.level.value, 10) || 1; }));
meta.demostart.addEventListener('change', () => store.updateQuietly((c) => { c.meta.demostart = parseFloat(meta.demostart.value) || 0; }));
meta.bpm.addEventListener('change', () => {
  const v = parseFloat(meta.bpm.value);
  if (v > 0) store.mutate((c) => { c.bpm = v; });
  else syncMetaForm();
});
meta.offset.addEventListener('change', () => {
  const v = parseFloat(meta.offset.value);
  if (Number.isFinite(v)) store.mutate((c) => { c.offset = v; });
  else syncMetaForm();
});

// ---------------------------------------------------------------- 統計
function updateStats() {
  const s = chartStats(store.chart);
  const notes = store.chart.notes;
  let length = 0;
  if (notes.length) {
    const first = tickToTime(store.chart, notes[0].tick);
    const last = tickToTime(store.chart, Math.max(...notes.map(noteEndTick)));
    length = last - first;
  }
  const density = length > 0 ? (s.total / length).toFixed(2) : '-';
  $('stats').innerHTML = `
    <span>音符 <b>${s.total}</b></span>
    <span>ドン <b>${s.don}</b></span>
    <span>カッ <b>${s.ka}</b></span>
    <span>大音符 <b>${s.big}</b></span>
    <span>連打 <b>${s.roll}</b></span>
    <span>密度 <b>${density}</b> 打/秒</span>
    <span>BPM <b>${store.chart.bpm}</b></span>`;
}

// ---------------------------------------------------------------- 書き出し・読み込み
function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function safeName(name) {
  return (name || 'chart').replace(/[\\/:*?"<>|]/g, '_');
}

$('export-tja').addEventListener('click', () => {
  if (!store.chart.notes.length && !confirm('音符がありません。空の譜面を書き出しますか？')) return;
  // TJAPlayer 系で文字化けしないよう BOM 付き UTF-8 で書き出す
  download(`${safeName(store.chart.meta.title)}.tja`, '﻿' + chartToTJA(store.chart), 'text/plain;charset=utf-8');
});

async function readText(file) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes); // 古い TJA は Shift_JIS が多い
  }
}

$('import-tja').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { chart, courses, warnings } = parseTJA(await readText(file), meta.course.value);
    store.replace(chart);
    lastOnsets = null;
    const lines = [`${file.name} を読み込みました（${chart.meta.course}, ${chart.notes.length} 音符）`];
    if (courses.length > 1) lines.push(`含まれるコース: ${courses.join(', ')}（コース欄を変えて読み込み直すと別のコースを読めます）`);
    lines.push(...warnings);
    toast(lines.join('\n'), { duration: 7000 });
  } catch (err) {
    toast(`TJA を読み込めませんでした: ${err.message}`, { error: true });
  }
});

$('export-json').addEventListener('click', () => {
  const data = { app: 'taiko-chart-maker', version: 1, chart: store.chart };
  download(`${safeName(store.chart.meta.title)}.json`, JSON.stringify(data, null, 2), 'application/json');
});

$('import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const chart = data.chart || data;
    if (!Array.isArray(chart.notes)) throw new Error('譜面データがありません');
    store.replace({ ...createChart(), ...chart, meta: { ...createChart().meta, ...chart.meta } });
    toast(`${file.name} を読み込みました`);
  } catch (err) {
    toast(`プロジェクトを読み込めませんでした: ${err.message}`, { error: true });
  }
});

$('clear-chart').addEventListener('click', () => {
  if (!store.chart.notes.length) return;
  if (!confirm('すべての音符を削除します（元に戻す で復元できます）。よろしいですか？')) return;
  store.mutate((c) => { c.notes = []; });
});

// ---------------------------------------------------------------- 初期表示
syncMetaForm();
updateStats();
player.setMusicVolume(Number($('music-vol').value));
player.setSeVolume(Number($('se-vol').value));
if (store.chart.notes.length) toast('前回の譜面を復元しました（音声は再度読み込んでください）');

// テスト・デバッグ用
window.taikoApp = { store, player, editor };
