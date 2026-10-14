import test from 'node:test';
import assert from 'node:assert/strict';
import { chartToTJA, parseTJA, createChart, normalizeNotes, NOTE, TPB, tickToTime, timeToTick } from '../js/chart.js';

const body = (tja) => tja.split('#START\n')[1].split('\n#END')[0].split('\n');

test('小節ごとに必要最小の分割数で書き出す', () => {
  const chart = createChart();
  chart.notes = [
    { tick: 0, type: NOTE.DON },
    { tick: 96, type: NOTE.KA },          // 1小節目: 2分割
    { tick: 192 + 12, type: NOTE.DON },   // 2小節目: 16分
    { tick: 192 * 3 + 16, type: NOTE.BIG_DON }, // 4小節目: 3連（12分割）
  ];
  assert.deepEqual(body(chartToTJA(chart)), ['12,', '0100000000000000,', '0,', '030000000000,']);
});

test('OFFSET は「小節0の開始時刻」の符号を反転して書き出す', () => {
  const chart = createChart();
  chart.offset = 1.25;
  chart.bpm = 150;
  const tja = chartToTJA(chart);
  assert.match(tja, /^OFFSET:-1\.25$/m);
  assert.match(tja, /^BPM:150$/m);
});

test('連打は 5 … 8 で書き出し、読み込みで長さが戻る', () => {
  const chart = createChart();
  chart.notes = [{ tick: 48, type: NOTE.ROLL, len: 240 }, { tick: 384, type: NOTE.KA }];
  const tja = chartToTJA(chart);
  assert.deepEqual(body(tja), ['0500,', '08,', '2,']);
  const { chart: back } = parseTJA(tja);
  assert.deepEqual(back.notes, chart.notes);
});

test('書き出し→読み込みで譜面が一致する', () => {
  const chart = createChart();
  chart.bpm = 172.5;
  chart.offset = 0.321;
  chart.meta = { title: 'テスト曲', subtitle: 'サブ', wave: 'song.ogg', course: 'Hard', level: 6, demostart: 12.5 };
  chart.notes = normalizeNotes(Array.from({ length: 200 }, (_, i) => ({ tick: i * 8 + (i % 3) * 4, type: (i % 4) + 1 })));
  const { chart: back, warnings } = parseTJA(chartToTJA(chart));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, chart);
});

test('#MEASURE・コメント・複数コース・Shift_JIS 由来でない一般的な TJA を読める', () => {
  const tja = `﻿TITLE:Sample
BPM:120
OFFSET:-0.5
COURSE:Easy
LEVEL:2
#START
1000,
#END
COURSE:3
LEVEL:9
#START
#MEASURE 3/4
111, // 3/4 小節
#MEASURE 4/4
2000
2000,
#GOGOSTART
#BPMCHANGE 200
3,
#END
`;
  const { chart, courses, warnings } = parseTJA(tja, 'Oni');
  assert.deepEqual(courses, ['Easy', 'Oni']);
  assert.equal(chart.meta.level, 9);
  assert.equal(chart.offset, 0.5);
  assert.deepEqual(chart.notes.map((n) => [n.tick, n.type]), [[0, 1], [48, 1], [96, 1], [144, 2], [240, 2], [336, 3]]);
  assert.ok(warnings.some((w) => w.includes('#BPMCHANGE')));
  const easy = parseTJA(tja, 'Easy').chart;
  assert.deepEqual(easy.notes, [{ tick: 0, type: 1 }]);
});

test('ティックと時刻の変換', () => {
  const chart = { ...createChart(), bpm: 150, offset: 0.2 };
  assert.equal(tickToTime(chart, TPB), 0.2 + 0.4);
  assert.ok(Math.abs(timeToTick(chart, 0.6) - TPB) < 1e-9);
});
