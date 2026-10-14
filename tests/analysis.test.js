import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, quantizeOnsets } from '../js/analysis.js';
import { NOTE, TPB } from '../js/chart.js';
import { synthDrums } from './synth.js';

const PATTERN = ['D', 0, 'K', 0, 'D', 0, 'K', 'K', 'D', 0, 'K', 0, 'D', 'D', 'K', 0];

function compare(notes, truth) {
  const byTick = new Map(notes.map((n) => [n.tick, n]));
  let hit = 0, typeOk = 0;
  for (const t of truth) {
    const n = byTick.get(t.tick);
    if (!n) continue;
    hit++;
    const isDon = n.type === NOTE.DON || n.type === NOTE.BIG_DON;
    if (isDon === (t.type === 'D')) typeOk++;
  }
  return { recall: hit / truth.length, precision: hit / notes.length, typeAcc: typeOk / Math.max(1, hit) };
}

for (const bpm of [100, 140, 175]) {
  test(`合成ドラム ${bpm}BPM から BPM・オフセット・音符を復元できる`, () => {
    const offset = 0.73;
    const { samples, sampleRate, truth } = synthDrums({ bpm, offset, measures: 16, pattern: PATTERN });
    const result = analyze(samples, sampleRate, { donRatio: 0.5, bigRatio: 0, minGapTicks: TPB / 4, sensitivity: 0.6 });
    assert.ok(Math.abs(result.bpm - bpm) < 0.2, `bpm ${result.bpm}`);
    // オフセットは小節単位でずれていてもよいが、ティックは真値と一致するはず
    const measure = (60 / bpm) * 4;
    const shift = Math.round((offset - result.offset) / measure);
    assert.ok(Math.abs(offset - shift * measure - result.offset) < 0.015, `offset ${result.offset}`);
    const shifted = truth.map((t) => ({ ...t, tick: t.tick + shift * TPB * 4 }));
    const { recall, precision, typeAcc } = compare(result.notes, shifted);
    assert.ok(recall > 0.95, `recall ${recall}`);
    assert.ok(precision > 0.95, `precision ${precision}`);
    assert.ok(typeAcc > 0.95, `type accuracy ${typeAcc}`);
  });
}

test('BPM を指定すると推定せずにその値を使う', () => {
  const { samples, sampleRate } = synthDrums({ bpm: 140, offset: 0.5, measures: 8, pattern: PATTERN });
  const result = analyze(samples, sampleRate, { bpm: 140 });
  assert.equal(result.bpm, 140);
});

test('最小間隔より近い弱い音は間引かれる', () => {
  const onsets = [
    { time: 0, strength: 1, lowness: 0.9 },
    { time: 0.125, strength: 0.5, lowness: 0.1 }, // 16分（120BPM）
    { time: 0.25, strength: 0.8, lowness: 0.1 },
  ];
  const notes = quantizeOnsets(onsets, 120, 0, { division: 4, minGapTicks: TPB / 2, donRatio: 0.34, bigRatio: 0 });
  assert.deepEqual(notes, [{ tick: 0, type: NOTE.DON }, { tick: 24, type: NOTE.KA }]);
});

test('3連符グリッドを許可すると3連の位置に量子化される', () => {
  const onsets = [0, 1, 2].map((i) => ({ time: (i * 0.5) / 3, strength: 1, lowness: 0.9 }));
  const straight = quantizeOnsets(onsets, 120, 0, { division: 4, triplets: false, minGapTicks: 1, bigRatio: 0, donRatio: 1 });
  const triplet = quantizeOnsets(onsets, 120, 0, { division: 4, triplets: true, minGapTicks: 1, bigRatio: 0, donRatio: 1 });
  assert.deepEqual(straight.map((n) => n.tick), [0, 12, 36]);
  assert.deepEqual(triplet.map((n) => n.tick), [0, 16, 32]);
});

test('無音でもエラーにならない', () => {
  const result = analyze(new Float32Array(22050 * 2), 22050);
  assert.equal(result.notes.length, 0);
});
