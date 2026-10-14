// 音源の再生と、譜面に合わせたヒット音（ドン/カッ）・メトロノームの発音。
import { TPB, isRoll, isKa, isBig, tickToTime, timeToTick } from './chart.js';

const LOOKAHEAD = 0.12;   // 先読みしてスケジュールする時間（秒）
const SCHEDULE_MS = 25;

export class Player {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.rate = 1;
    this.startCtxTime = 0;  // 再生開始時の AudioContext 時刻
    this.startPos = 0;      // 再生開始時の曲内位置（秒）
    this.pausedAt = 0;
    this.scheduledUntil = 0;
    this.timer = null;
    this.getChart = () => null;
    this.hitSounds = true;
    this.metronome = false;
    this.onEnded = () => {};
    this.musicVolume = 0.8;
    this.seVolume = 0.7;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.musicGain = this.ctx.createGain();
      this.seGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.seGain.gain.value = this.seVolume;
      this.musicGain.connect(this.ctx.destination);
      this.seGain.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.2);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    return ctx.decodeAudioData(arrayBuffer);
  }

  setBuffer(buffer) {
    this.stop();
    this.buffer = buffer;
    this.pausedAt = 0;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : Infinity;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.musicGain) this.musicGain.gain.value = v;
  }

  setSeVolume(v) {
    this.seVolume = v;
    if (this.seGain) this.seGain.gain.value = v;
  }

  setRate(rate) {
    const pos = this.currentTime;
    this.rate = rate;
    if (this.playing) this.play(pos);
  }

  /** 実際に聞こえている位置（出力レイテンシを考慮）。 */
  get currentTime() {
    if (!this.playing) return this.pausedAt;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const elapsed = Math.max(0, this.ctx.currentTime - latency - this.startCtxTime);
    return this.startPos + elapsed * this.rate;
  }

  play(from = this.pausedAt) {
    const ctx = this.ensureContext();
    this.stopSource();
    this.startPos = Math.max(0, from);
    this.startCtxTime = ctx.currentTime + 0.05;
    this.scheduledUntil = this.startPos;
    if (this.buffer && this.startPos < this.buffer.duration) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this.rate;
      src.connect(this.musicGain);
      src.start(this.startCtxTime, this.startPos);
      src.onended = () => {
        if (this.source === src && this.playing) {
          this.pause();
          this.onEnded();
        }
      };
      this.source = src;
    }
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), SCHEDULE_MS);
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.currentTime;
    this.playing = false;
    this.stopSource();
    clearInterval(this.timer);
  }

  stop() {
    this.pause();
    this.pausedAt = 0;
  }

  seek(time) {
    const t = Math.max(0, Math.min(time, this.buffer ? this.buffer.duration : time));
    if (this.playing) this.play(t);
    else this.pausedAt = t;
  }

  stopSource() {
    if (this.source) {
      try { this.source.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** 曲内時刻 → AudioContext 時刻 */
  ctxTimeOf(songTime) {
    return this.startCtxTime + (songTime - this.startPos) / this.rate;
  }

  schedule() {
    const chart = this.getChart();
    if (!chart || !this.playing) return;
    const ctx = this.ctx;
    const from = this.scheduledUntil;
    const to = this.startPos + (ctx.currentTime + LOOKAHEAD - this.startCtxTime) * this.rate;
    if (to <= from) return;
    this.scheduledUntil = to;
    const inRange = (t) => t >= from && t < to && t >= this.startPos;

    if (this.hitSounds) {
      for (const n of chart.notes) {
        const t = tickToTime(chart, n.tick);
        if (isRoll(n.type)) {
          // 連打は 16 分ごとに軽く鳴らす
          for (let k = n.tick; k <= n.tick + n.len; k += TPB / 4) {
            const tt = tickToTime(chart, k);
            if (inRange(tt)) this.hit(1, this.ctxTimeOf(tt), k === n.tick ? 1 : 0.45);
          }
        } else if (inRange(t)) {
          this.hit(n.type, this.ctxTimeOf(t), isBig(n.type) ? 1.4 : 1);
        }
      }
    }
    if (this.metronome) {
      const first = Math.ceil(timeToTick(chart, from) / TPB);
      const last = Math.floor(timeToTick(chart, to) / TPB);
      for (let b = first; b <= last; b++) {
        const t = tickToTime(chart, b * TPB);
        if (inRange(t)) this.click(this.ctxTimeOf(t), b % 4 === 0);
      }
    }
  }

  /** ヒット音を鳴らす（when 省略で即時）。 */
  hit(type, when, gain = 1) {
    const ctx = this.ensureContext();
    const t = Math.max(when ?? ctx.currentTime, ctx.currentTime);
    if (isKa(type)) this.playKa(t, gain);
    else this.playDon(t, gain);
  }

  playDon(t, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    g.gain.setValueAtTime(0.9 * gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g).connect(this.seGain);
    osc.start(t);
    osc.stop(t + 0.25);

    const n = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const ng = ctx.createGain();
    n.buffer = this.noise;
    f.type = 'lowpass';
    f.frequency.value = 900;
    ng.gain.setValueAtTime(0.35 * gain, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(ng).connect(this.seGain);
    n.start(t);
    n.stop(t + 0.06);
  }

  playKa(t, gain) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    n.buffer = this.noise;
    f.type = 'bandpass';
    f.frequency.value = 2600;
    f.Q.value = 2;
    g.gain.setValueAtTime(0.9 * gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    n.connect(f).connect(g).connect(this.seGain);
    n.start(t);
    n.stop(t + 0.08);

    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1400;
    og.gain.setValueAtTime(0.25 * gain, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(og).connect(this.seGain);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  click(t, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1800 : 1200;
    g.gain.setValueAtTime(accent ? 0.35 : 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(g).connect(this.seGain);
    osc.start(t);
    osc.stop(t + 0.04);
  }
}

/** 波形表示用に、一定間隔ごとの最小値・最大値を求める。 */
export function computePeaks(buffer, bucketsPerSecond = 400) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const size = Math.max(1, Math.floor(buffer.sampleRate / bucketsPerSecond));
  const count = Math.ceil(buffer.length / size);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(buffer.length, (b + 1) * size);
    for (let i = b * size; i < end; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, rate: buffer.sampleRate / size };
}
