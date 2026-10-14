// 音声から譜面を自動生成する解析処理（ブラウザ／Node 共通・DOM 非依存）。
//
// 処理の流れ:
//   1. STFT で周波数帯域ごと（低域・中域・高域）のスペクトルフラックスを計算
//   2. オンセット（音の立ち上がり）をピーク検出
//   3. オンセット包絡線の自己相関で BPM 候補を推定し、位相の揃い具合で精密化
//   4. 拍の位相と小節頭（ダウンビート）を推定してオフセットを決定
//   5. オンセットをグリッドに量子化し、低域優勢ならドン・高域優勢ならカッに分類
//
// 機械学習モデルではなく信号処理ベースのヒューリスティクスなので、
// 生成結果はあくまで「下書き」。エディタでの手修正を前提にしている。

import { FFT } from './fft.js';
import { TPB, NOTE } from './chart.js';

export const DEFAULT_OPTIONS = Object.freeze({
  sensitivity: 0.6,     // 0〜1。大きいほど小さな音も拾う
  division: 4,          // 1拍あたりの分割数（1=4分, 2=8分, 4=16分）
  triplets: false,      // 3連符グリッドも許可する
  minGapTicks: TPB / 4, // 音符同士の最小間隔（ティック）
  donRatio: 0.6,        // ドンにする割合（低域寄りの音から順に）
  bigRatio: 0.04,       // 大音符にする割合（強い音から順に）
  bpm: null,            // 固定BPM。null なら自動推定
  minBpm: 60,
  maxBpm: 240,
});

export const DIFFICULTY_PRESETS = Object.freeze({
  easy: { sensitivity: 0.35, division: 1, triplets: false, minGapTicks: TPB, bigRatio: 0.08 },
  normal: { sensitivity: 0.45, division: 2, triplets: false, minGapTicks: TPB / 2, bigRatio: 0.06 },
  hard: { sensitivity: 0.6, division: 4, triplets: false, minGapTicks: TPB / 4, bigRatio: 0.04 },
  oni: { sensitivity: 0.75, division: 4, triplets: true, minGapTicks: TPB / 6, bigRatio: 0.03 },
});

const BANDS = [[30, 250], [250, 2000], [2000, 12000]];
// テンポの事前分布（log2 スケールのガウス）。太鼓の楽曲は 100〜220 BPM 程度が多く、
// 半分のテンポを選ぶと16分音符が表現できなくなるため、やや速めを好むようにしている。
const PREFERRED_BPM = 150;
const PREFERRED_WIDTH = 0.7;
// STFT 窓の影響でオンセットが実際より早く検出される分の補正（秒）
const ONSET_LATENCY = 0.006;
// 拍頭と裏拍の強さの差がこれ未満なら、テンポを倍にして考える
const CONTRAST_THRESHOLD = 0.3;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mod = (x, m) => ((x % m) + m) % m;

export function quantile(values, q) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** 帯域別スペクトルフラックスを計算する。フレームは i*hop サンプルを中心とする。 */
export function computeFeatures(samples, sampleRate, onProgress) {
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  let size = 256;
  while (size < hop * 4) size *= 2;
  const half = size / 2;
  const nFrames = Math.max(1, Math.ceil(samples.length / hop));

  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);

  const binHz = sampleRate / size;
  const bandOf = new Int8Array(half).fill(-1);
  const counts = [0, 0, 0];
  for (let k = 1; k < half; k++) {
    const f = k * binHz;
    for (let b = 0; b < BANDS.length; b++) {
      if (f >= BANDS[b][0] && f < Math.min(BANDS[b][1], sampleRate / 2)) {
        bandOf[k] = b;
        counts[b]++;
      }
    }
  }

  const fft = new FFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const prev = new Float64Array(half);
  const bands = BANDS.map(() => new Float32Array(nFrames));
  const scale = 4 / size; // フルスケール正弦波 ≒ 1
  const sums = [0, 0, 0];

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < size; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < samples.length ? samples[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    sums[0] = sums[1] = sums[2] = 0;
    for (let k = 1; k < half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      const lm = Math.log1p(100 * mag);
      const d = lm - prev[k];
      prev[k] = lm;
      const b = bandOf[k];
      if (d > 0 && b >= 0) sums[b] += d;
    }
    for (let b = 0; b < 3; b++) bands[b][f] = counts[b] ? sums[b] / counts[b] : 0;
    if (onProgress && f % 2000 === 0) onProgress(f / nFrames);
  }

  return {
    fps: sampleRate / hop,
    duration: samples.length / sampleRate,
    low: bands[0],
    mid: bands[1],
    high: bands[2],
  };
}

/** 各帯域を上位1%点で正規化し、合成したオンセット包絡線を返す。 */
export function onsetEnvelope(features) {
  const norm = (arr) => {
    let q = quantile(arr, 0.99);
    if (!(q > 0)) q = Math.max(...arr) || 1;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / q;
    return out;
  };
  const low = norm(features.low);
  const mid = norm(features.mid);
  const high = norm(features.high);
  const env = new Float32Array(low.length);
  for (let i = 0; i < env.length; i++) env[i] = (low[i] + mid[i] + high[i]) / 3;
  return { env, low, mid, high, fps: features.fps };
}

/** 包絡線のピークをオンセットとして取り出す。 */
export function pickOnsets(envelope, sensitivity) {
  const { env, low, high, fps } = envelope;
  const n = env.length;
  const delta = 0.4 - 0.37 * clamp(sensitivity, 0, 1);
  const w1 = Math.max(1, Math.round(0.03 * fps));
  const w2 = Math.max(2, Math.round(0.15 * fps));
  const minGap = Math.max(1, Math.round(0.045 * fps));

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  const around = (arr, i) => Math.max(arr[i], i > 0 ? arr[i - 1] : 0, i + 1 < n ? arr[i + 1] : 0);

  const onsets = [];
  let lastFrame = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = env[i];
    if (v < delta) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - w1); j <= Math.min(n - 1, i + w1); j++) {
      if (env[j] > v || (env[j] === v && j < i)) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    const a = Math.max(0, i - w2);
    const b = Math.min(n, i + w2 + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    if (v < mean + delta) continue;

    // 放物線補間でサブフレーム精度にする
    let p = 0;
    if (i > 0 && i < n - 1) {
      const denom = env[i - 1] - 2 * v + env[i + 1];
      if (denom < 0) p = clamp((0.5 * (env[i - 1] - env[i + 1])) / denom, -0.5, 0.5);
    }
    const lo = around(low, i);
    const hi = around(high, i);
    const onset = {
      time: (i + p) / fps + ONSET_LATENCY,
      strength: v,
      lowness: lo / (lo + hi + 1e-9),
    };
    if (i - lastFrame < minGap) {
      if (v > onsets[onsets.length - 1].strength) onsets[onsets.length - 1] = onset;
      else continue;
    } else {
      onsets.push(onset);
    }
    lastFrame = i;
  }
  return onsets;
}

/** 包絡線の自己相関から BPM 候補をスコア順に返す。 */
export function estimateTempoCandidates(env, fps, minBpm = 60, maxBpm = 240) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const x = Float64Array.from(env, (v) => v - mean);

  const minLag = Math.max(1, Math.floor((60 * fps) / maxBpm));
  const maxLag = Math.ceil((60 * fps) / minBpm);
  const maxL = Math.min(n - 1, maxLag * 2 + 2);
  const acf = new Float64Array(maxL + 2);
  for (let L = minLag; L <= maxL; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += x[i] * x[i + L];
    acf[L] = s / (n - L);
  }

  const score = new Float64Array(maxLag + 2);
  for (let L = minLag; L <= Math.min(maxLag, maxL); L++) {
    const s = acf[L] + (2 * L <= maxL ? 0.5 * acf[2 * L] : 0);
    const bpm = (60 * fps) / L;
    const w = Math.exp(-0.5 * (Math.log2(bpm / PREFERRED_BPM) / PREFERRED_WIDTH) ** 2);
    score[L] = s * w;
  }

  const candidates = [];
  for (let L = minLag + 1; L < Math.min(maxLag, maxL); L++) {
    if (score[L] > 0 && score[L] >= score[L - 1] && score[L] >= score[L + 1]) {
      const denom = score[L - 1] - 2 * score[L] + score[L + 1];
      const p = denom < 0 ? clamp((0.5 * (score[L - 1] - score[L + 1])) / denom, -0.5, 0.5) : 0;
      candidates.push({ bpm: (60 * fps) / (L + p), score: score[L] });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);
  const best = top[0]?.score || 1;
  return top.length ? top.map((c) => ({ bpm: c.bpm, score: c.score / best })) : [{ bpm: 120, score: 1 }];
}

/**
 * 拍周期に対するオンセットの位相の揃い具合（円周統計）。
 * 拍・8分・16分の各周期の揃い具合を合計したスコア（0〜1）と、16分グリッドの位相を返す。
 */
function phaseCoherence(onsets, period) {
  const sums = [[0, 0], [0, 0], [0, 0]];
  const harmonics = [1, 2, 4];
  let total = 0;
  for (const o of onsets) {
    const th = (2 * Math.PI * o.time) / period;
    for (let h = 0; h < 3; h++) {
      sums[h][0] += o.strength * Math.cos(harmonics[h] * th);
      sums[h][1] += o.strength * Math.sin(harmonics[h] * th);
    }
    total += o.strength;
  }
  const r = sums.map(([c, s]) => Math.hypot(c, s));
  return {
    score: (r[0] + r[1] + r[2]) / (3 * (total || 1)),
    phase16: Math.atan2(sums[2][1], sums[2][0]),
  };
}

/** BPM を ±range の範囲で精密化する。曲全体で位相が最もよく揃う BPM を選ぶ。 */
export function refineTempo(onsets, bpm0, range = 0.03) {
  return refineTempoScored(onsets, bpm0, range).bpm;
}

function refineTempoScored(onsets, bpm0, range = 0.03) {
  if (onsets.length < 4) return { bpm: bpm0, score: 0 };
  const search = (lo, hi, step) => {
    let best = { bpm: bpm0, score: -Infinity };
    for (let bpm = lo; bpm <= hi; bpm += step) {
      const { score } = phaseCoherence(onsets, 60 / bpm);
      if (score > best.score) best = { bpm, score };
    }
    return best;
  };
  const coarse = search(bpm0 * (1 - range), bpm0 * (1 + range), 0.02);
  const fine = search(coarse.bpm - 0.03, coarse.bpm + 0.03, 0.002);
  // 整数BPMでほぼ同等なら整数に寄せる（多くの楽曲は整数BPM）
  const rounded = Math.round(fine.bpm);
  if (Math.abs(rounded - fine.bpm) < 0.08) {
    const { score } = phaseCoherence(onsets, 60 / rounded);
    if (score >= fine.score * 0.98) return { bpm: rounded, score };
  }
  return { bpm: Math.round(fine.bpm * 1000) / 1000, score: fine.score };
}

/**
 * 拍の強弱のコントラスト。拍頭と裏拍（8分裏）に来る音の重みを比べる。
 * 正しいテンポでは拍頭に強い音（特に低域）が集まり、裏拍との差が大きくなる。
 */
function beatContrast(onsets, bpm) {
  const period = 60 / bpm;
  const sixteenth = period / 4;
  const { phase16 } = phaseCoherence(onsets, period);
  const grid0 = mod((phase16 / (2 * Math.PI)) * sixteenth, sixteenth);
  const slots = [0, 0, 0, 0];
  for (const o of onsets) {
    const s = Math.round((o.time - grid0) / sixteenth);
    if (Math.abs(o.time - (grid0 + s * sixteenth)) < sixteenth * 0.4) {
      slots[mod(s, 4)] += o.strength * (0.5 + o.lowness);
    }
  }
  const k = slots.indexOf(Math.max(...slots));
  const on = slots[k];
  const off = slots[(k + 2) % 4];
  return (on - off) / (on + off || 1);
}

/** 16分グリッドにどれだけ音が乗っているか（強さで重み付けした割合）。 */
function gridFit(onsets, bpm) {
  const sixteenth = 60 / bpm / 4;
  const { phase16 } = phaseCoherence(onsets, 60 / bpm);
  const grid0 = (phase16 / (2 * Math.PI)) * sixteenth;
  let on = 0, total = 0;
  for (const o of onsets) {
    const d = mod(o.time - grid0 + sixteenth / 2, sixteenth) - sixteenth / 2;
    if (Math.abs(d) < sixteenth * 0.25) on += o.strength;
    total += o.strength;
  }
  return on / (total || 1);
}

/**
 * 自己相関の候補から BPM を決める。
 * 1. 倍・半分以外の関係（2:3 など）にある候補は、位相の揃い具合で選び直す
 * 2. 倍・半分の曖昧さは、遅いほうから順に「裏拍が拍頭と同じくらい強い」か
 *    「16分グリッドに乗らない音が多い」なら倍にする、で解消する
 */
export function chooseTempo(onsets, candidates, minBpm = 60, maxBpm = 240) {
  const octaveOf = (a, b) => [2, 4, 0.5, 0.25].some((r) => Math.abs(a / b / r - 1) < 0.03);
  const distinct = [];
  for (const c of candidates) {
    if (!distinct.some((d) => octaveOf(c.bpm, d.bpm))) distinct.push(c);
  }
  let best = null;
  for (const c of distinct.slice(0, 4)) {
    const r = refineTempoScored(onsets, c.bpm);
    const total = r.score * Math.sqrt(c.score);
    if (!best || total > best.total) best = { bpm: r.bpm, total };
  }
  if (!best) return 120;

  const octaves = [0.25, 0.5, 1, 2, 4]
    .map((f) => best.bpm * f)
    .filter((b) => b >= minBpm * 0.97 && b <= maxBpm * 1.03);
  const refined = octaves.map((b) => (b === best.bpm ? b : refineTempo(onsets, b, 0.005)));
  for (let i = 0; i < refined.length - 1; i++) {
    const bpm = refined[i];
    const tooSlow = gridFit(onsets, bpm) < 0.85 * gridFit(onsets, refined[i + 1]);
    if (!tooSlow && beatContrast(onsets, bpm) >= CONTRAST_THRESHOLD) return bpm;
  }
  return refined.length ? refined[refined.length - 1] : best.bpm;
}

/** 拍の位相と小節頭を推定し、小節 0 の開始時刻（オフセット）を返す。 */
export function estimateOffset(onsets, bpm) {
  if (!onsets.length) return 0;
  const period = 60 / bpm;
  const sixteenth = period / 4;
  // 16分グリッドの位相は全オンセットから精度よく求まる
  const { phase16 } = phaseCoherence(onsets, period);
  const grid0 = mod((phase16 / (2 * Math.PI)) * sixteenth, sixteenth);

  // 小節内の16分位置ごとに重みを集計し、小節頭らしい位置を探す。
  // 小節頭・拍頭に低域の強い音（ドン）が多く来るとみなす。
  const slots = new Float64Array(16);
  for (const o of onsets) {
    const s = Math.round((o.time - grid0) / sixteenth);
    if (Math.abs(o.time - (grid0 + s * sixteenth)) < sixteenth * 0.4) {
      slots[mod(s, 16)] += o.strength * (0.3 + o.lowness);
    }
  }
  let bestK = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    let score = 0;
    for (let r = 0; r < 16; r++) {
      const w = r === 0 ? 1.5 : r % 4 === 0 ? 1 : r % 2 === 0 ? 0.25 : 0;
      score += w * slots[(k + r) % 16];
    }
    if (score > bestScore) { bestScore = score; bestK = k; }
  }
  const measure = period * 4;
  let offset = mod(grid0 + bestK * sixteenth, measure);
  const first = Math.min(...onsets.map((o) => o.time));
  if (first < offset - sixteenth) offset -= measure;
  return Math.round(offset * 10000) / 10000;
}

/** オンセットをグリッドに量子化し、ドン/カッ・大音符を割り当てる。 */
export function quantizeOnsets(onsets, bpm, offset, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (!onsets.length || !(bpm > 0)) return [];
  const beatSec = 60 / bpm;
  const snapS = Math.max(1, Math.round(TPB / o.division));
  const snapT = TPB / (o.division >= 4 ? 6 : 3);

  const donThr = o.donRatio > 0 ? quantile(onsets.map((x) => x.lowness), 1 - o.donRatio) : Infinity;
  const bigThr = o.bigRatio > 0 ? quantile(onsets.map((x) => x.strength), 1 - o.bigRatio) : Infinity;

  const candidates = [];
  for (const on of onsets) {
    const pos = ((on.time - offset) / beatSec) * TPB;
    let tick = Math.round(pos / snapS) * snapS;
    if (o.triplets) {
      const tt = Math.round(pos / snapT) * snapT;
      if (tt % snapS !== 0 && Math.abs(pos - tt) < Math.abs(pos - tick) * 0.5) tick = tt;
    }
    if (tick < 0) continue;
    const don = on.lowness >= donThr;
    const big = on.strength >= bigThr;
    const type = don ? (big ? NOTE.BIG_DON : NOTE.DON) : (big ? NOTE.BIG_KA : NOTE.KA);
    candidates.push({ tick, type, strength: on.strength });
  }

  // 強い音から順に採用し、最小間隔より近い弱い音は捨てる
  candidates.sort((a, b) => b.strength - a.strength);
  const gap = Math.max(1, Math.round(o.minGapTicks));
  const accepted = new Map();
  for (const c of candidates) {
    let free = true;
    for (let d = -(gap - 1); d <= gap - 1 && free; d++) {
      if (accepted.has(c.tick + d)) free = false;
    }
    if (free) accepted.set(c.tick, { tick: c.tick, type: c.type });
  }

  // 連続した音符の中の大音符は叩きにくいので小音符に戻す
  const notes = [...accepted.values()].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.type !== NOTE.BIG_DON && n.type !== NOTE.BIG_KA) continue;
    const near = (j) => j >= 0 && j < notes.length && Math.abs(notes[j].tick - n.tick) < TPB / 2;
    if (near(i - 1) || near(i + 1)) n.type = n.type === NOTE.BIG_DON ? NOTE.DON : NOTE.KA;
  }
  return notes;
}

/**
 * 音声サンプル（モノラル）を解析して譜面の下書きを作る。
 * @returns {{ bpm, offset, candidates, onsets, notes, duration }}
 */
export function analyze(samples, sampleRate, options = {}, onProgress = () => {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const features = computeFeatures(samples, sampleRate, (p) => onProgress(p * 0.85));
  onProgress(0.85);
  const envelope = onsetEnvelope(features);
  const onsets = pickOnsets(envelope, o.sensitivity);
  // テンポ推定は難易度設定に左右されないよう、ある程度細かいオンセットを使う
  const tempoOnsets = o.sensitivity >= 0.6 ? onsets : pickOnsets(envelope, 0.6);

  let bpm;
  let candidates;
  if (o.bpm > 0) {
    bpm = o.bpm;
    candidates = [{ bpm, score: 1 }];
  } else {
    candidates = estimateTempoCandidates(envelope.env, envelope.fps, o.minBpm, o.maxBpm);
    onProgress(0.9);
    bpm = chooseTempo(tempoOnsets, candidates, o.minBpm, o.maxBpm);
    candidates = candidates.map((c) => ({ bpm: Math.round(c.bpm * 100) / 100, score: c.score }));
  }
  const offset = estimateOffset(tempoOnsets, bpm);
  const notes = quantizeOnsets(onsets, bpm, offset, o);
  onProgress(1);
  return { bpm, offset, candidates, onsets, notes, duration: features.duration };
}
