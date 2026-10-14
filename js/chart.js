// 譜面データモデルと TJA 形式の入出力。
//
// 譜面は「拍あたり TPB ティック」の整数ティックで音符位置を持つ。
// 48 ティック/拍なので 4分・8分・16分・32分・3連符・6連符(24分)を誤差なく表現できる。

export const TPB = 48;
export const BEATS_PER_MEASURE = 4;
export const TICKS_PER_MEASURE = TPB * BEATS_PER_MEASURE;

export const NOTE = Object.freeze({
  DON: 1,
  KA: 2,
  BIG_DON: 3,
  BIG_KA: 4,
  ROLL: 5,
  BIG_ROLL: 6,
});

export const NOTE_LABEL = {
  [NOTE.DON]: 'ドン',
  [NOTE.KA]: 'カッ',
  [NOTE.BIG_DON]: '大ドン',
  [NOTE.BIG_KA]: '大カッ',
  [NOTE.ROLL]: '連打',
  [NOTE.BIG_ROLL]: '大連打',
};

export const COURSES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];

export const isRoll = (t) => t === NOTE.ROLL || t === NOTE.BIG_ROLL;
export const isDon = (t) => t === NOTE.DON || t === NOTE.BIG_DON;
export const isKa = (t) => t === NOTE.KA || t === NOTE.BIG_KA;
export const isBig = (t) => t === NOTE.BIG_DON || t === NOTE.BIG_KA || t === NOTE.BIG_ROLL;

export function createChart() {
  return {
    meta: { title: '', subtitle: '', wave: '', course: 'Oni', level: 8, demostart: 0 },
    bpm: 120,
    offset: 0,
    notes: [],
  };
}

export const tickToTime = (chart, tick) => chart.offset + (tick / TPB) * (60 / chart.bpm);
export const timeToTick = (chart, time) => ((time - chart.offset) * chart.bpm / 60) * TPB;

/** ティック順に並べ、同一ティックの重複を後勝ちで除去する。 */
export function normalizeNotes(notes) {
  const byTick = new Map();
  for (const n of notes) {
    if (!Number.isFinite(n.tick) || n.tick < 0) continue;
    const note = { tick: Math.round(n.tick), type: n.type };
    if (isRoll(n.type)) note.len = Math.max(1, Math.round(n.len || TPB / 4));
    byTick.set(note.tick, note);
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

export function noteEndTick(note) {
  return note.tick + (isRoll(note.type) ? note.len : 0);
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

function formatNumber(x, digits = 3) {
  const s = Number(x).toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** 譜面を TJA テキストに変換する（4/4 拍子・単一BPM）。 */
export function chartToTJA(chart) {
  const notes = normalizeNotes(chart.notes);
  const events = new Map(); // tick -> 文字
  for (const n of notes) {
    events.set(n.tick, String(n.type));
  }
  for (const n of notes) {
    if (!isRoll(n.type)) continue;
    const end = noteEndTick(n);
    if (!events.has(end)) events.set(end, '8');
  }
  const lastTick = events.size ? Math.max(...events.keys()) : 0;
  const measureCount = Math.floor(lastTick / TICKS_PER_MEASURE) + 1;

  const lines = [];
  for (let m = 0; m < measureCount; m++) {
    const start = m * TICKS_PER_MEASURE;
    const ticks = [];
    for (const t of events.keys()) {
      if (t >= start && t < start + TICKS_PER_MEASURE) ticks.push(t - start);
    }
    if (!ticks.length) {
      lines.push('0,');
      continue;
    }
    let g = TICKS_PER_MEASURE;
    for (const t of ticks) g = gcd(g, t);
    const chars = new Array(TICKS_PER_MEASURE / g).fill('0');
    for (const t of ticks) chars[t / g] = events.get(start + t);
    lines.push(chars.join('') + ',');
  }

  const meta = chart.meta || {};
  const header = [
    `TITLE:${meta.title || 'Untitled'}`,
    `SUBTITLE:${meta.subtitle ? `--${meta.subtitle}` : ''}`,
    `BPM:${formatNumber(chart.bpm)}`,
    `WAVE:${meta.wave || ''}`,
    `OFFSET:${formatNumber(-chart.offset)}`,
    `DEMOSTART:${formatNumber(meta.demostart || 0)}`,
    'SONGVOL:100',
    'SEVOL:100',
    '',
    `COURSE:${meta.course || 'Oni'}`,
    `LEVEL:${meta.level ?? 8}`,
    'BALLOON:',
    'SCOREINIT:',
    'SCOREDIFF:',
    '',
    '#START',
  ];
  return [...header, ...lines, '#END', ''].join('\n');
}

const COURSE_BY_NUMBER = { 0: 'Easy', 1: 'Normal', 2: 'Hard', 3: 'Oni', 4: 'Edit' };

function normalizeCourse(value) {
  const v = String(value || '').trim();
  if (v in COURSE_BY_NUMBER) return COURSE_BY_NUMBER[v];
  const found = COURSES.find((c) => c.toLowerCase() === v.toLowerCase());
  if (found) return found;
  if (/^ura$/i.test(v)) return 'Edit';
  return v || 'Oni';
}

/**
 * TJA テキストを解析する。
 * 対応: TITLE/SUBTITLE/BPM/WAVE/OFFSET/DEMOSTART/COURSE/LEVEL、#MEASURE、音符 0-8。
 * 非対応の命令（#BPMCHANGE など）は無視して warnings に記録する。
 * @returns {{ chart, courses: string[], warnings: string[] }}
 */
export function parseTJA(text, preferredCourse) {
  const warnings = new Set();
  const global = {};
  const courses = [];
  let current = null; // 現在の COURSE ブロック
  let body = null;    // #START〜#END の行

  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (body) {
      if (/^#END\b/i.test(line)) {
        current.body = body;
        body = null;
      } else {
        body.push(line);
      }
      continue;
    }
    if (/^#START\b/i.test(line)) {
      if (/^#START\s+P\d/i.test(line)) warnings.add('2P譜面 (#START P1/P2) は 1 つ目のみ読み込みます');
      if (!current || current.body) {
        current = { course: current?.course ?? global.COURSE ?? 'Oni', level: current?.level ?? global.LEVEL, body: null };
        courses.push(current);
      }
      body = [];
      continue;
    }
    const m = line.match(/^([A-Z0-9]+):(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const value = m[2].trim();
    if (key === 'COURSE') {
      current = { course: normalizeCourse(value), level: undefined, body: null };
      courses.push(current);
    } else if (key === 'LEVEL' && current) {
      current.level = value;
    } else {
      global[key] = value;
    }
  }
  if (body && current) current.body = body; // #END 欠落

  const usable = courses.filter((c) => c.body);
  if (!usable.length) throw new Error('#START 〜 #END の譜面データが見つかりません');
  const target = usable.find((c) => c.course === preferredCourse) || usable[usable.length - 1];

  const chart = createChart();
  chart.bpm = parseFloat(global.BPM) || 120;
  chart.offset = -(parseFloat(global.OFFSET) || 0);
  chart.meta.title = global.TITLE || '';
  chart.meta.subtitle = (global.SUBTITLE || '').replace(/^(--|\+\+)/, '');
  chart.meta.wave = global.WAVE || '';
  chart.meta.demostart = parseFloat(global.DEMOSTART) || 0;
  chart.meta.course = target.course;
  chart.meta.level = parseInt(target.level ?? global.LEVEL, 10) || 1;

  let measureTicks = TICKS_PER_MEASURE;
  let pos = 0;
  let buffer = '';
  let rollStart = null;
  const notes = [];

  const flushMeasure = () => {
    const count = buffer.length;
    for (let i = 0; i < count; i++) {
      const exact = pos + (measureTicks * i) / count;
      const tick = Math.round(exact);
      if (Math.abs(exact - tick) > 1e-6) warnings.add('ティック分解能 (1/48拍) で表現できない位置の音符を丸めました');
      const c = buffer[i];
      if (c === '1' || c === '2' || c === '3' || c === '4') {
        notes.push({ tick, type: Number(c) });
      } else if (c === 'A' || c === 'B') {
        notes.push({ tick, type: c === 'A' ? NOTE.BIG_DON : NOTE.BIG_KA });
      } else if (c === '5' || c === '6' || c === '7' || c === '9') {
        if (c === '7' || c === '9') warnings.add('風船音符は連打として読み込みます');
        rollStart = { tick, type: c === '6' ? NOTE.BIG_ROLL : NOTE.ROLL };
      } else if (c === '8') {
        if (rollStart) {
          notes.push({ ...rollStart, len: Math.max(1, tick - rollStart.tick) });
          rollStart = null;
        }
      } else if (c !== '0') {
        warnings.add(`未対応の音符 "${c}" を無視しました`);
      }
    }
    pos += measureTicks;
    buffer = '';
  };

  for (const line of target.body) {
    if (line.startsWith('#')) {
      const cmd = line.match(/^#(\w+)\s*(.*)$/);
      const name = cmd ? cmd[1].toUpperCase() : '';
      if (name === 'MEASURE') {
        const [num, den] = cmd[2].split('/').map(Number);
        if (num > 0 && den > 0) {
          measureTicks = (TICKS_PER_MEASURE * num) / den;
          if (num !== den) warnings.add('#MEASURE は読み込み時のタイミングにのみ反映され、書き出しは 4/4 になります');
        }
      } else if (['GOGOSTART', 'GOGOEND', 'BARLINEOFF', 'BARLINEON', 'SCROLL'].includes(name)) {
        // 演出系の命令はタイミングに影響しないので無視
      } else {
        warnings.add(`未対応の命令 #${name} を無視しました`);
      }
      continue;
    }
    for (const c of line) {
      if (c === ',') flushMeasure();
      else if (!/\s/.test(c)) buffer += c;
    }
  }
  if (buffer) flushMeasure();

  chart.notes = normalizeNotes(notes);
  return { chart, courses: usable.map((c) => c.course), warnings: [...warnings] };
}

/** 譜面の統計（音符数など） */
export function chartStats(chart) {
  const s = { total: 0, don: 0, ka: 0, big: 0, roll: 0 };
  for (const n of chart.notes) {
    if (isRoll(n.type)) { s.roll++; continue; }
    s.total++;
    if (isDon(n.type)) s.don++;
    if (isKa(n.type)) s.ka++;
    if (isBig(n.type)) s.big++;
  }
  return s;
}
