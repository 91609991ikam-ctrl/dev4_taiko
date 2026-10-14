// テスト用の合成ドラム音源
export function synthDrums({ bpm, offset, measures, pattern, sampleRate = 22050, noise = 0.01, seed = 1 }) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const beat = 60 / bpm;
  const duration = offset + measures * beat * 4 + 1;
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = noise * rand();
  const truth = [];
  for (let m = 0; m < measures; m++) {
    pattern.forEach((type, slot) => {
      if (!type) return;
      const t = offset + (m * 16 + slot) * beat / 4;
      const tick = (m * 16 + slot) * 12;
      truth.push({ tick, type, time: t });
      const start = Math.round(t * sampleRate);
      const loud = slot === 0 ? 1 : 0.7;
      if (type === 'D') {
        for (let i = 0; i < 0.18 * sampleRate && start + i < out.length; i++) {
          const x = i / sampleRate;
          out[start + i] += loud * Math.exp(-x * 25) * Math.sin(2 * Math.PI * (90 + 60 * Math.exp(-x * 40)) * x);
        }
      } else if (type === 'S') {
        for (let i = 0; i < 0.15 * sampleRate && start + i < out.length; i++) {
          const x = i / sampleRate;
          out[start + i] += loud * Math.exp(-x * 30) * (0.5 * rand() + 0.6 * Math.sin(2 * Math.PI * 190 * x));
        }
      } else if (type === 'H') {
        let prev = 0;
        for (let i = 0; i < 0.03 * sampleRate && start + i < out.length; i++) {
          const x = i / sampleRate;
          const r = rand();
          out[start + i] += 0.25 * Math.exp(-x * 150) * (r - prev);
          prev = r;
        }
      } else {
        let prev = 0;
        for (let i = 0; i < 0.06 * sampleRate && start + i < out.length; i++) {
          const x = i / sampleRate;
          const r = rand();
          out[start + i] += loud * 0.6 * Math.exp(-x * 70) * (r - prev + 0.5 * Math.sin(2 * Math.PI * 3500 * x));
          prev = r;
        }
      }
    });
  }
  return { samples: out, sampleRate, truth };
}
