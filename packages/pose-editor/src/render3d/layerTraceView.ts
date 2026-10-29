/**
 * ИНСПЕКТОР СЛОЁВ — «что играет сейчас и с каким весом».
 *
 * Закрывает вопрос, на который в инструменте не было ответа НИГДЕ: почему персонаж выглядит именно
 * так. Слоёв пять, веса считаются в трёх разных местах, и до этого оставалось только гадать — ноги
 * сейчас у планировщика или у клипа удара, стойка та или подставилась базовая, оверлей щита вообще
 * приехал или нет. В Unreal ровно эту дырку закрывает дорожка Blend Weights в Animation Insights,
 * в Unity — подсветка активного состояния в окне Animator.
 *
 * ⚠ ОКНО НИЧЕГО НЕ СЧИТАЕТ. Все числа приходят готовыми из `layerTrace`, который заполняет сам
 * рантайм там же, где эти веса и рождаются. Соблазн пересчитать «то же самое» здесь велик и ошибочен:
 * это вторая правда, она разойдётся с первой молча, и врать начнёт именно окно отладки — то самое,
 * которому верят в спорной ситуации.
 *
 * Один модуль на редактор и на игру: смотреть на разные цифры в двух местах — это ровно та беда,
 * ради которой инспектор и делается.
 */
import { layerTrace, type TraceRow } from './poseRuntime.js';

export interface LayerTraceView {
  el: HTMLElement;
  /** Перерисовать по текущей трассе. Зовётся из кадрового цикла. */
  update(): void;
  /** Снять с учёта: трасса перестаёт собираться, если её больше никто не смотрит. */
  dispose(): void;
}

let watchers = 0;
/**
 * Подписаться на трассу: пока есть хоть один зритель, рантайм собирает строки. Возвращает отписку (идемпотентную).
 * Нужна не только окну инспектора: панель весов слоёв показывает «сейчас NN %» из ТЕХ ЖЕ строк — свой пересчёт
 * там был бы второй правдой.
 */
export function watchLayerTrace(): () => void {
  watchers++; layerTrace.on = true;
  let done = false;
  return () => { if (done) return; done = true; watchers = Math.max(0, watchers - 1); if (!watchers) layerTrace.on = false; };
}

const css = {
  box: 'position:relative;width:300px;background:rgba(12,14,20,.92);border:1px solid #39415a;border-radius:6px;'
    + 'padding:6px 8px;font:11px/1.35 monospace;color:#cfd3e0;pointer-events:auto;user-select:none',
  head: 'color:#8fb7ff;font-weight:bold;font-size:11px;margin-bottom:3px',
  mode: 'color:#9aa3b8;font-size:10px;margin-bottom:5px;white-space:pre-wrap',
  row: 'display:flex;align-items:center;gap:5px;margin-top:2px',
  name: 'flex:0 0 104px;color:#cfd3e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
  bar: 'flex:1 1 auto;height:8px;background:#1b2030;border-radius:3px;overflow:hidden',
  pct: 'flex:0 0 30px;text-align:right;font-size:10px',
  src: 'color:#9ae6a0;font-size:10px;margin:0 0 1px 109px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
  note: 'color:#6b7180;font-size:9px;margin:0 0 2px 109px',
};

/** Цвет веса: работает — зелёный, на подходе — жёлтый, спит — серый. Глазами видно за полсекунды. */
const tint = (w: number): string => (w > 0.66 ? '#46d07a' : w > 0.05 ? '#ffd24a' : '#4a5680');

export function createLayerTraceView(): LayerTraceView {
  const el = document.createElement('div');
  el.style.cssText = css.box;
  const head = document.createElement('div'); head.style.cssText = css.head; head.textContent = 'СЛОИ — что играет сейчас';
  const mode = document.createElement('div'); mode.style.cssText = css.mode;
  const body = document.createElement('div');
  el.append(head, mode, body);

  const unwatch = watchLayerTrace();
  let stale = 0;

  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  const drawRow = (r: TraceRow): void => {
    const line = document.createElement('div'); line.style.cssText = css.row;
    const nm = document.createElement('span'); nm.style.cssText = css.name; nm.textContent = r.layer;
    const bar = document.createElement('div'); bar.style.cssText = css.bar;
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:${Math.max(0, Math.min(1, r.w)) * 100}%;background:${tint(r.w)}`;
    bar.append(fill);
    const p = document.createElement('span'); p.style.cssText = css.pct + `;color:${tint(r.w)}`; p.textContent = pct(r.w);
    line.append(nm, bar, p);
    body.append(line);
    const src = document.createElement('div'); src.style.cssText = css.src;
    src.style.color = r.src.startsWith('нет') ? '#c05050' : '#9ae6a0';
    src.textContent = r.src;
    body.append(src);
    if (r.note) { const n = document.createElement('div'); n.style.cssText = css.note; n.textContent = r.note; body.append(n); }
  };

  const update = (): void => {
    // Трасса не обновлялась — значит кукла не шагает (или её вообще нет). Честно сказать это дешевле,
    // чем показывать застывшие числа: застывшие выглядят как настоящие и уводят в неверную сторону.
    if (Date.now() - layerTrace.t > 500) {
      if (stale === 1) return;
      stale = 1; body.replaceChildren();
      mode.textContent = 'кукла не обновляется — включи превью';
      return;
    }
    stale = 0;
    const t = layerTrace;
    const gait = t.sb <= 0.001 ? 'ходьба' : t.sb >= 0.999 ? 'бег' : `ходьба→бег ${pct(t.sb)}`;
    mode.textContent = `${t.speed.toFixed(0)} ед/с · ${gait}`
      + (t.st > 0.005 ? ` · вбок ${pct(t.st)}` : '')
      + (t.combat > 0.005 ? ` · бой ${pct(t.combat)}` : '')
      + `\nскрутка: шаг ${(t.twistGait * 57.3).toFixed(0)}° · прицел ${(t.twistAim * 57.3).toFixed(0)}°`;
    body.replaceChildren();
    for (const r of t.rows) drawRow(r);
    if (!t.rows.length) { const d = document.createElement('div'); d.style.cssText = css.note; d.textContent = 'слоёв нет'; body.append(d); }
  };

  return {
    el,
    update,
    dispose(): void { unwatch(); el.remove(); },
  };
}
