// 譜面エディタ（Canvas）。横スクロールのタイムライン上で音符を配置・編集する。
import {
  TPB, TICKS_PER_MEASURE, NOTE, isRoll, isKa, isBig,
  tickToTime, timeToTick, noteEndTick,
} from './chart.js';

export const TOOL = { SELECT: 'select', ERASER: 'eraser' };

const RULER_H = 26;
const LANE_H = 120;
const WAVE_H = 90;
const HEIGHT = RULER_H + LANE_H + WAVE_H;
const LANE_Y = RULER_H + LANE_H / 2;

const COLORS = {
  bg: '#1d1a24',
  lane: '#2b2633',
  laneBefore: '#221e29',
  ruler: '#15131a',
  measure: 'rgba(255,255,255,0.75)',
  beat: 'rgba(255,255,255,0.28)',
  sub: 'rgba(255,255,255,0.09)',
  wave: '#6b6280',
  waveBg: '#18161d',
  don: '#f05a3c',
  ka: '#46b4c8',
  roll: '#f7b928',
  playhead: '#ffe14d',
  select: 'rgba(255, 225, 77, 0.18)',
  text: '#bdb6c9',
};

function noteRadius(type) {
  return isBig(type) ? 25 : 16;
}

function noteColor(type) {
  if (isRoll(type)) return COLORS.roll;
  return isKa(type) ? COLORS.ka : COLORS.don;
}

export class ChartEditor {
  constructor(canvas, store, { onSeek = () => {}, onStatus = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.onSeek = onSeek;
    this.onStatus = onStatus;

    this.pxPerSec = 300;
    this.scrollTime = -0.5;
    this.snap = TPB / 4;
    this.tool = NOTE.DON;
    this.playhead = 0;
    this.follow = true;
    this.playing = false;
    this.peaks = null;
    this.duration = 0;
    this.onsets = [];
    this.showOnsets = true;
    this.selection = new Set(); // 選択中の音符のティック
    this.clipboard = [];
    this.hover = null;          // { tick } ゴースト表示
    this.drag = null;
    this.dirty = true;

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    store.addEventListener('change', () => {
      const ticks = new Set(store.chart.notes.map((n) => n.tick));
      for (const t of [...this.selection]) if (!ticks.has(t)) this.selection.delete(t);
      this.invalidate();
    });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    const loop = () => {
      if (this.dirty) this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get chart() { return this.store.chart; }

  invalidate() { this.dirty = true; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.parentElement.clientWidth;
    this.width = width;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  // ---- 座標変換 ----
  xOfTime(t) { return (t - this.scrollTime) * this.pxPerSec; }
  timeOfX(x) { return this.scrollTime + x / this.pxPerSec; }
  xOfTick(tick) { return this.xOfTime(tickToTime(this.chart, tick)); }
  snapTick(rawTick) { return Math.max(0, Math.round(rawTick / this.snap) * this.snap); }
  tickOfX(x) { return this.snapTick(timeToTick(this.chart, this.timeOfX(x))); }

  // ---- 外部からの操作 ----
  setTool(tool) { this.tool = tool; this.invalidate(); }
  setSnap(ticks) { this.snap = ticks; this.invalidate(); }
  setPeaks(peaks, duration) { this.peaks = peaks; this.duration = duration; this.invalidate(); }
  setOnsets(onsets) { this.onsets = onsets || []; this.invalidate(); }

  setPlayhead(t, playing) {
    this.playhead = t;
    this.playing = playing;
    // 再生中は再生位置が左から 1/4 の位置に来るようスクロールする
    if (playing && this.follow) this.scrollTime = t - (this.width * 0.25) / this.pxPerSec;
    this.invalidate();
  }

  zoom(factor, anchorX = this.width / 2) {
    const anchorT = this.timeOfX(anchorX);
    this.pxPerSec = Math.min(2000, Math.max(20, this.pxPerSec * factor));
    this.scrollTime = anchorT - anchorX / this.pxPerSec;
    this.invalidate();
  }

  scrollBy(dt) {
    this.scrollTime += dt;
    this.invalidate();
  }

  revealTime(t) {
    if (t < this.scrollTime || t > this.timeOfX(this.width)) {
      this.scrollTime = t - (this.width * 0.25) / this.pxPerSec;
      this.invalidate();
    }
  }

  selectAll() {
    this.selection = new Set(this.chart.notes.map((n) => n.tick));
    this.invalidate();
  }

  clearSelection() {
    this.selection.clear();
    this.invalidate();
  }

  deleteSelection() {
    if (!this.selection.size) return false;
    const sel = this.selection;
    this.store.mutate((c) => { c.notes = c.notes.filter((n) => !sel.has(n.tick)); });
    this.onStatus(`${sel.size} 個の音符を削除しました`);
    this.selection = new Set();
    return true;
  }

  moveSelection(deltaTicks) {
    if (!this.selection.size) return false;
    const sel = this.selection;
    const moved = this.chart.notes.filter((n) => sel.has(n.tick));
    if (moved.some((n) => n.tick + deltaTicks < 0)) return true;
    this.store.mutate((c) => {
      const rest = c.notes.filter((n) => !sel.has(n.tick));
      const shifted = moved.map((n) => ({ ...n, tick: n.tick + deltaTicks }));
      const taken = new Set(shifted.map((n) => n.tick));
      c.notes = [...rest.filter((n) => !taken.has(n.tick)), ...shifted];
    });
    this.selection = new Set(moved.map((n) => n.tick + deltaTicks));
    return true;
  }

  /** 選択中の音符の種類を変える（ドン⇔カッ、大⇔小）。 */
  transformSelection(fn) {
    if (!this.selection.size) return false;
    const sel = this.selection;
    this.store.mutate((c) => {
      c.notes = c.notes.map((n) => (sel.has(n.tick) && !isRoll(n.type) ? { ...n, type: fn(n.type) } : n));
    });
    return true;
  }

  copySelection() {
    const notes = this.chart.notes.filter((n) => this.selection.has(n.tick));
    if (!notes.length) return false;
    const base = notes[0].tick;
    this.clipboard = notes.map((n) => ({ ...n, tick: n.tick - base }));
    this.onStatus(`${notes.length} 個の音符をコピーしました`);
    return true;
  }

  paste(atTime) {
    if (!this.clipboard.length) return false;
    const base = this.snapTick(timeToTick(this.chart, atTime));
    const pasted = this.clipboard.map((n) => ({ ...n, tick: n.tick + base }));
    this.store.mutate((c) => {
      const taken = new Set(pasted.map((n) => n.tick));
      c.notes = [...c.notes.filter((n) => !taken.has(n.tick)), ...pasted];
    });
    this.selection = new Set(pasted.map((n) => n.tick));
    this.onStatus(`${pasted.length} 個の音符を貼り付けました`);
    return true;
  }

  /** リアルタイム入力などで、指定時刻に音符を置く。 */
  placeAtTime(time, type) {
    const tick = this.snapTick(timeToTick(this.chart, time));
    this.store.mutate((c) => {
      c.notes = c.notes.filter((n) => n.tick !== tick);
      c.notes.push({ tick, type });
    });
    return tick;
  }

  // ---- ヒットテスト ----
  noteAt(x, y) {
    if (y < RULER_H || y > RULER_H + LANE_H) return null;
    let found = null;
    // 手前（時間が早いもの）に描かれる音符を優先
    for (const n of this.chart.notes) {
      const nx = this.xOfTick(n.tick);
      const r = noteRadius(n.type);
      if (isRoll(n.type)) {
        const ex = this.xOfTick(noteEndTick(n));
        if (x >= nx - r && x <= ex + r && Math.abs(y - LANE_Y) <= r) { found = n; break; }
      } else if (Math.hypot(x - nx, y - LANE_Y) <= r + 2) {
        found = n;
        break;
      }
    }
    return found;
  }

  pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- マウス操作 ----
  onPointerDown(e) {
    const { x, y } = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    const inLane = y >= RULER_H && y <= RULER_H + LANE_H;

    if (!inLane) {
      this.drag = { kind: 'seek' };
      this.onSeek(Math.max(0, this.timeOfX(x)));
      return;
    }
    if (e.button === 1) {
      this.drag = { kind: 'pan', x, scroll: this.scrollTime };
      return;
    }
    const hit = this.noteAt(x, y);

    if (e.button === 2 || this.tool === TOOL.ERASER) {
      if (hit) this.store.mutate((c) => { c.notes = c.notes.filter((n) => n.tick !== hit.tick); });
      this.drag = { kind: 'erase' };
      return;
    }
    if (e.shiftKey || this.tool === TOOL.SELECT) {
      if (hit && !e.shiftKey) {
        if (!this.selection.has(hit.tick)) this.selection = new Set([hit.tick]);
        this.drag = { kind: 'move', startTick: this.tickOfX(x), delta: 0 };
      } else {
        if (!e.shiftKey) this.selection.clear();
        this.drag = { kind: 'box', x0: x, x1: x, base: new Set(this.selection) };
      }
      this.invalidate();
      return;
    }

    // 音符ツール
    if (hit) {
      if (hit.type === this.tool) {
        this.store.mutate((c) => { c.notes = c.notes.filter((n) => n.tick !== hit.tick); });
      } else {
        this.store.mutate((c) => {
          const n = c.notes.find((m) => m.tick === hit.tick);
          n.type = this.tool;
          if (isRoll(this.tool) && !n.len) n.len = TPB;
        });
      }
      return;
    }
    const tick = this.tickOfX(x);
    if (isRoll(this.tool)) {
      this.drag = { kind: 'roll', tick, end: tick + Math.max(this.snap, TPB / 2) };
    } else {
      this.store.mutate((c) => { c.notes.push({ tick, type: this.tool }); });
      this.drag = { kind: 'paint', last: tick };
    }
  }

  onPointerMove(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      const inLane = y >= RULER_H && y <= RULER_H + LANE_H;
      const showGhost = inLane && this.tool !== TOOL.SELECT && this.tool !== TOOL.ERASER && !this.noteAt(x, y);
      this.hover = showGhost ? { tick: this.tickOfX(x) } : null;
      this.canvas.style.cursor = inLane ? (this.tool === TOOL.SELECT ? 'default' : 'crosshair') : 'col-resize';
      this.invalidate();
      return;
    }
    if (d.kind === 'seek') {
      this.onSeek(Math.max(0, this.timeOfX(x)));
    } else if (d.kind === 'pan') {
      this.scrollTime = d.scroll - (x - d.x) / this.pxPerSec;
    } else if (d.kind === 'erase') {
      const hit = this.noteAt(x, y);
      if (hit) this.store.mutate((c) => { c.notes = c.notes.filter((n) => n.tick !== hit.tick); });
    } else if (d.kind === 'paint') {
      // ドラッグで連続配置
      const tick = this.tickOfX(x);
      if (tick !== d.last && !this.chart.notes.some((n) => n.tick === tick)) {
        this.store.mutate((c) => { c.notes.push({ tick, type: this.tool }); });
      }
      d.last = tick;
    } else if (d.kind === 'roll') {
      d.end = Math.max(d.tick + this.snap, this.tickOfX(x));
    } else if (d.kind === 'box') {
      d.x1 = x;
      const t0 = timeToTick(this.chart, this.timeOfX(Math.min(d.x0, d.x1)));
      const t1 = timeToTick(this.chart, this.timeOfX(Math.max(d.x0, d.x1)));
      this.selection = new Set(d.base);
      for (const n of this.chart.notes) if (n.tick >= t0 && n.tick <= t1) this.selection.add(n.tick);
    } else if (d.kind === 'move') {
      d.delta = this.tickOfX(x) - d.startTick;
    }
    this.invalidate();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'roll') {
      this.store.mutate((c) => {
        c.notes = c.notes.filter((n) => n.tick < d.tick || n.tick > d.end);
        c.notes.push({ tick: d.tick, type: this.tool, len: d.end - d.tick });
      });
    } else if (d.kind === 'move' && d.delta) {
      this.moveSelection(d.delta);
    }
    this.invalidate();
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(-e.deltaY * 0.0015), this.pos(e).x);
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.scrollBy(delta / this.pxPerSec);
    }
  }

  // ---- 描画 ----
  render() {
    this.dirty = false;
    const { ctx, width } = this;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, HEIGHT);

    // 背景（小節0より前は暗く）
    const x0 = Math.max(0, Math.min(width, this.xOfTick(0)));
    ctx.fillStyle = COLORS.laneBefore;
    ctx.fillRect(0, RULER_H, x0, LANE_H);
    ctx.fillStyle = COLORS.lane;
    ctx.fillRect(x0, RULER_H, width - x0, LANE_H);
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, width, RULER_H);
    ctx.fillStyle = COLORS.waveBg;
    ctx.fillRect(0, RULER_H + LANE_H, width, WAVE_H);

    this.renderGrid();
    this.renderWaveform();
    this.renderOnsets();
    this.renderSelectionBox();
    this.renderNotes();

    // 判定枠（レーン左の円）風の装飾
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(width, RULER_H + 0.5);
    ctx.moveTo(0, RULER_H + LANE_H + 0.5);
    ctx.lineTo(width, RULER_H + LANE_H + 0.5);
    ctx.stroke();

    // 再生位置
    const px = this.xOfTime(this.playhead);
    if (px >= -2 && px <= width + 2) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.fill();
    }
  }

  renderGrid() {
    const { ctx, width, chart } = this;
    const tStart = Math.floor(timeToTick(chart, this.timeOfX(0)));
    const tEnd = Math.ceil(timeToTick(chart, this.timeOfX(width)));
    const pxPerTick = (this.pxPerSec * 60) / chart.bpm / TPB;
    let step = this.snap;
    while (step * pxPerTick < 6 && step < TICKS_PER_MEASURE) step = step < TPB ? TPB : TICKS_PER_MEASURE;
    const first = Math.ceil(tStart / step) * step;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let t = first; t <= tEnd; t += step) {
      const x = Math.round(this.xOfTick(t)) + 0.5;
      const isMeasure = ((t % TICKS_PER_MEASURE) + TICKS_PER_MEASURE) % TICKS_PER_MEASURE === 0;
      const isBeat = t % TPB === 0;
      ctx.strokeStyle = isMeasure ? COLORS.measure : isBeat ? COLORS.beat : COLORS.sub;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, isMeasure ? 0 : RULER_H);
      ctx.lineTo(x, RULER_H + LANE_H + WAVE_H);
      ctx.stroke();
      if (isMeasure && t >= 0) {
        ctx.fillStyle = COLORS.text;
        ctx.fillText(`#${t / TICKS_PER_MEASURE + 1}`, x + 4, RULER_H / 2);
      }
    }
    // 秒表示
    ctx.fillStyle = 'rgba(189,182,201,0.55)';
    ctx.textAlign = 'right';
    const secStep = this.pxPerSec > 120 ? 1 : this.pxPerSec > 40 ? 5 : 10;
    for (let s = Math.ceil(this.timeOfX(0) / secStep) * secStep; s <= this.timeOfX(width); s += secStep) {
      if (s < 0) continue;
      const x = this.xOfTime(s);
      const m = Math.floor(s / 60);
      ctx.fillText(`${m}:${String(s % 60).padStart(2, '0')}`, x - 3, RULER_H + LANE_H + WAVE_H - 8);
    }
    ctx.textAlign = 'left';
  }

  renderWaveform() {
    const { ctx, width, peaks } = this;
    if (!peaks) return;
    const mid = RULER_H + LANE_H + WAVE_H / 2;
    const amp = WAVE_H / 2 - 6;
    ctx.fillStyle = COLORS.wave;
    for (let x = 0; x < width; x++) {
      const t0 = this.timeOfX(x);
      const t1 = this.timeOfX(x + 1);
      if (t1 < 0 || t0 > this.duration) continue;
      const b0 = Math.max(0, Math.floor(t0 * peaks.rate));
      const b1 = Math.min(peaks.min.length, Math.max(b0 + 1, Math.ceil(t1 * peaks.rate)));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      const y0 = mid - hi * amp;
      const y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  renderOnsets() {
    if (!this.showOnsets || !this.onsets.length) return;
    const { ctx, width } = this;
    const base = RULER_H + LANE_H + 2;
    for (const o of this.onsets) {
      const x = this.xOfTime(o.time);
      if (x < -4 || x > width + 4) continue;
      const h = 6 + Math.min(1.5, o.strength) * 14;
      ctx.fillStyle = o.lowness >= 0.5 ? 'rgba(240,90,60,0.8)' : 'rgba(70,180,200,0.8)';
      ctx.fillRect(x - 1, base, 2, h);
    }
  }

  renderSelectionBox() {
    const d = this.drag;
    if (!d || d.kind !== 'box') return;
    const { ctx } = this;
    ctx.fillStyle = COLORS.select;
    ctx.fillRect(Math.min(d.x0, d.x1), RULER_H, Math.abs(d.x1 - d.x0), LANE_H);
  }

  renderNotes() {
    const { width, chart } = this;
    const moveDelta = this.drag?.kind === 'move' ? this.drag.delta : 0;
    const visible = [];
    for (const n of chart.notes) {
      const shift = this.selection.has(n.tick) ? moveDelta : 0;
      const x = this.xOfTick(n.tick + shift);
      const ex = isRoll(n.type) ? this.xOfTick(noteEndTick(n) + shift) : x;
      if (ex < -40 || x > width + 40) continue;
      visible.push({ n, x, ex });
    }
    if (this.drag?.kind === 'roll') {
      const d = this.drag;
      visible.push({ n: { tick: d.tick, type: this.tool, len: d.end - d.tick }, x: this.xOfTick(d.tick), ex: this.xOfTick(d.end), ghost: true });
    }
    // 早い音符が手前に来るよう、遅い順に描く
    visible.sort((a, b) => b.n.tick - a.n.tick);
    for (const v of visible) this.drawNote(v.x, v.ex, v.n.type, this.selection.has(v.n.tick), v.ghost ? 0.6 : 1);
    if (this.hover && !this.drag) {
      this.drawNote(this.xOfTick(this.hover.tick), this.xOfTick(this.hover.tick + TPB / 2), this.tool, false, 0.35);
    }
  }

  drawNote(x, ex, type, selected, alpha) {
    const { ctx } = this;
    const r = noteRadius(type);
    const y = LANE_Y;
    ctx.globalAlpha = alpha;
    if (isRoll(type)) {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.roundRect(x - r - 2, y - r - 2, ex - x + 2 * r + 4, 2 * r + 4, r + 2);
      ctx.fill();
      ctx.fillStyle = COLORS.roll;
      ctx.beginPath();
      ctx.roundRect(x - r + 1, y - r + 1, ex - x + 2 * r - 2, 2 * r - 2, r);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f0e8';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = noteColor(type);
    ctx.beginPath();
    ctx.arc(x, y, r - 3.5, 0, Math.PI * 2);
    ctx.fill();
    // 顔の代わりのハイライト
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.25, y - r * 0.35, r * 0.4, r * 0.22, -0.4, 0, Math.PI * 2);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
