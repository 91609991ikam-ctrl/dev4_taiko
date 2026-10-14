// 譜面の状態と元に戻す/やり直す履歴を管理する。
import { createChart, normalizeNotes } from './chart.js';

const MAX_HISTORY = 200;

export class ChartStore extends EventTarget {
  constructor(chart = createChart()) {
    super();
    this.chart = chart;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 譜面を置き換える。resetHistory=false なら元に戻せる操作として扱う。 */
  replace(chart, { resetHistory = false } = {}) {
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
    } else {
      this.pushUndo();
    }
    this.chart = chart;
    this.chart.notes = normalizeNotes(this.chart.notes);
    this.emit();
  }

  /** fn(chart) で譜面を変更する。変更前の状態を履歴に積む。 */
  mutate(fn) {
    this.pushUndo();
    fn(this.chart);
    this.chart.notes = normalizeNotes(this.chart.notes);
    this.emit();
  }

  /** 履歴に残さずメタ情報などを更新する（入力欄の打鍵ごとに履歴を積まないため）。 */
  updateQuietly(fn) {
    fn(this.chart);
    this.emit();
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.chart));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.chart));
    this.chart = JSON.parse(this.undoStack.pop());
    this.emit();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.chart));
    this.chart = JSON.parse(this.redoStack.pop());
    this.emit();
    return true;
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }
}
