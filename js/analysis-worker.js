// 解析処理を UI スレッドから切り離して実行する Web Worker
import { analyze } from './analysis.js';

self.onmessage = (e) => {
  const { samples, sampleRate, options } = e.data;
  try {
    const result = analyze(samples, sampleRate, options, (value) => self.postMessage({ type: 'progress', value }));
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
