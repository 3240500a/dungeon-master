/**
 * ТАЙМ-ЛАЙН (Ф6) — вместо одной строки точек.
 *
 * Было: ключи рисовались `<div>`-кружками, перетащить их было нельзя, время кадра правилось только
 * числом в поле, дорожек по костям не существовало.
 *
 * Стало: канвас с линейкой, ключами-ромбами, плейхедом и (в Про) ДОРОЖКАМИ ПО ГРУППАМ КОСТЕЙ.
 * Ключи перетаскиваются, выделяются рамкой и Shift-кликом, дублируются и удаляются.
 * Форма перехода видна цветом ромба — это те самые `interp` из Ф1.2, а не отдельная сущность.
 *
 * Канвас, а не DOM: на клипе в 60 ключей × 8 дорожек это 480 узлов, которые пересоздавались бы
 * на каждый refresh панели (редактор перерисовывает панель целиком). Канвас рисуется за один проход.
 *
 * Модуль ЗАМКНУТ на переданные колбэки — он ничего не знает про библиотеку клипов и не пишет на сервер.
 */
import type { Clip, Keyframe, Interp } from './clipModel.js';
import { clipDur } from './clipModel.js';

/** Группы дорожек в Про-режиме: имя → предикат по имени кости. */
export const TRACK_GROUPS: readonly [string, RegExp][] = [
  ['таз/спина', /^(Root|Hips|Spine|Chest|UpperChest|Neck|Head)$/],
  ['рука Л', /^Left(Shoulder|UpperArm|LowerArm|Hand)$/],
  ['рука П', /^Right(Shoulder|UpperArm|LowerArm|Hand)$/],
  ['кисть Л', /^Left(Thumb|Index|Middle|Ring|Little)/],
  ['кисть П', /^Right(Thumb|Index|Middle|Ring|Little)/],
  ['нога Л', /^Left(UpperLeg|LowerLeg|Foot|Toes)$/],
  ['нога П', /^Right(UpperLeg|LowerLeg|Foot|Toes)$/],
];

/** Цвет ромба по форме перехода — форма читается с одного взгляда. */
export const INTERP_COLOR: Record<Interp | 'none', string> = {
  none: '#8fb7ff', linear: '#8fb7ff', ease: '#9ae6a0', step: '#ffcf66', fixed: '#b088ff',
};

export interface TimelineCallbacks {
  clip(): Clip | null;
  /** Индекс текущего кадра (курсор). */
  frameIdx(): number;
  /** Время плейхеда в секундах (проигрывание/скраб). */
  playT(): number;
  pro(): boolean;
  onSelectFrame(i: number): void;
  onScrub(t: number): void;
  /** Времена ключей изменились (перетаскивание) — сохранить и пересортировать. */
  onMoveKeys(moves: { index: number; t: number }[]): void;
  /** Выделение изменилось (для панели действий). */
  onSelectionChange(sel: number[]): void;
}

export interface TimelinePanel {
  /** Перерисовать (звать из refreshAll и из цикла при проигрывании). */
  draw(): void;
  /** Текущее выделение ключей (индексы). */
  selection(): number[];
  setSelection(sel: number[]): void;
  resize(): void;
  dispose(): void;
}

const PAD_L = 8, PAD_R = 8, RULER_H = 14, ROW_H = 13, KEY_R = 4.5;

/** Какие ГРУППЫ костей реально меняются в этом ключе относительно предыдущего (для дорожек). */
export function changedGroups(clip: Clip, i: number, epsRad = 0.01): Set<string> {
  const out = new Set<string>();
  const cur = clip.keys[i]?.pose; if (!cur) return out;
  const prev = i > 0 ? clip.keys[i - 1]?.pose : undefined;
  for (const nm in cur) {
    if (nm[0] === '_') continue;
    const a = prev?.[nm], b = cur[nm]!;
    if (prev && a && Math.abs(a[0] - b[0]) < epsRad && Math.abs(a[1] - b[1]) < epsRad && Math.abs(a[2] - b[2]) < epsRad) continue;
    for (const [label, re] of TRACK_GROUPS) if (re.test(nm)) { out.add(label); break; }
  }
  return out;
}

export function makeTimelinePanel(host: HTMLElement, cb: TimelineCallbacks): TimelinePanel {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:default';
  host.append(canvas);
  const ctx = canvas.getContext('2d')!;

  let sel: number[] = [];
  let dragging: { start: number; moved: boolean; base: Map<number, number> } | null = null;
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let w = 0, hgt = 0;

  const dur = (): number => Math.max(0.001, clipDur(cb.clip() ?? { keys: [] } as unknown as Clip));
  const xOf = (t: number): number => PAD_L + (t / dur()) * Math.max(1, w - PAD_L - PAD_R);
  const tOf = (x: number): number => ((x - PAD_L) / Math.max(1, w - PAD_L - PAD_R)) * dur();

  function resize(): void {
    const r = host.getBoundingClientRect();
    w = Math.max(100, r.width); hgt = Math.max(30, r.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(): void {
    // Само-пересинхронизация размера: ResizeObserver может не успеть за перекладкой панели,
    // и тогда бэкинг-стор остаётся маленьким и картинка растягивается (замечено: 264×34 на полосе в 800px).
    { const r = host.getBoundingClientRect(); if (Math.abs(r.width - w) > 1 || Math.abs(r.height - hgt) > 1) resize(); }
    const c = cb.clip();
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = '#14161e'; ctx.fillRect(0, 0, w, hgt);
    if (!c || !c.keys.length) {
      ctx.fillStyle = '#6b7180'; ctx.font = '11px monospace';
      ctx.fillText('нет кадров', PAD_L, hgt / 2);
      return;
    }
    const D = dur();
    // линейка
    ctx.strokeStyle = '#2a3040'; ctx.fillStyle = '#6b7180'; ctx.font = '9px monospace';
    const stepT = D <= 1 ? 0.1 : D <= 3 ? 0.25 : 0.5;
    for (let t = 0; t <= D + 1e-6; t += stepT) {
      const x = xOf(t);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillText(t.toFixed(2), x + 2, 9);
    }

    const pro = cb.pro();
    const groups = pro ? TRACK_GROUPS.filter(([lb]) => c.keys.some((_, i) => changedGroups(c, i).has(lb))) : [];
    const keyRowY = RULER_H + 8;

    // дорожки по группам (Про)
    if (pro) {
      ctx.font = '9px monospace';
      groups.forEach(([label], gi) => {
        const y = keyRowY + 10 + gi * ROW_H;
        ctx.fillStyle = '#1a1d26'; ctx.fillRect(0, y - ROW_H / 2, w, ROW_H - 1);
        ctx.fillStyle = '#6b7180'; ctx.fillText(label, 2, y + 3);
        for (let i = 0; i < c.keys.length; i++) {
          if (!changedGroups(c, i).has(label)) continue;
          const x = xOf(c.keys[i]!.t);
          ctx.fillStyle = '#4a6fa0';
          ctx.fillRect(x - 2, y - 3, 4, 6);
        }
      });
    }

    // плейхед
    const px = xOf(Math.min(D, Math.max(0, cb.playT())));
    ctx.strokeStyle = '#e05050'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, hgt); ctx.stroke();

    // ключи-ромбы
    const curI = cb.frameIdx();
    for (let i = 0; i < c.keys.length; i++) {
      const k = c.keys[i]!, x = xOf(k.t);
      const isSel = sel.includes(i), isCur = i === curI;
      ctx.beginPath();
      ctx.moveTo(x, keyRowY - KEY_R); ctx.lineTo(x + KEY_R, keyRowY);
      ctx.lineTo(x, keyRowY + KEY_R); ctx.lineTo(x - KEY_R, keyRowY); ctx.closePath();
      ctx.fillStyle = INTERP_COLOR[k.interp ?? 'none'];
      ctx.fill();
      if (isSel || isCur) { ctx.strokeStyle = isCur ? '#ffffff' : '#ffcf66'; ctx.lineWidth = isCur ? 1.6 : 1.2; ctx.stroke(); }
    }

    // рамка выделения
    if (box) {
      ctx.strokeStyle = '#ffcf66'; ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.setLineDash([]);
    }
  }

  const hitKey = (x: number, y: number): number => {
    const c = cb.clip(); if (!c) return -1;
    if (Math.abs(y - (RULER_H + 8)) > KEY_R + 4) return -1;
    let best = -1, bestD = KEY_R + 4;
    for (let i = 0; i < c.keys.length; i++) {
      const d = Math.abs(xOf(c.keys[i]!.t) - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const local = (ev: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };

  const onDown = (ev: PointerEvent): void => {
    const c = cb.clip(); if (!c) return;
    const [x, y] = local(ev);
    const i = hitKey(x, y);
    if (i >= 0) {
      if (ev.shiftKey) sel = sel.includes(i) ? sel.filter((v) => v !== i) : [...sel, i];
      else if (!sel.includes(i)) sel = [i];
      cb.onSelectFrame(i);
      cb.onSelectionChange(sel);
      const base = new Map<number, number>();
      for (const s of sel) base.set(s, c.keys[s]!.t);
      dragging = { start: x, moved: false, base };
      canvas.setPointerCapture(ev.pointerId);
    } else if (y < RULER_H + 4) {
      cb.onScrub(Math.max(0, Math.min(dur(), tOf(x))));      // клик по линейке — перемотка
    } else {
      box = { x0: x, y0: y, x1: x, y1: y };
      canvas.setPointerCapture(ev.pointerId);
    }
    draw();
  };

  const onMove = (ev: PointerEvent): void => {
    const c = cb.clip(); if (!c) return;
    const [x, y] = local(ev);
    if (dragging) {
      const dt = tOf(x) - tOf(dragging.start);
      if (Math.abs(x - dragging.start) > 2) dragging.moved = true;
      if (dragging.moved) {
        const moves: { index: number; t: number }[] = [];
        for (const [i, t0] of dragging.base) moves.push({ index: i, t: Math.max(0, +(t0 + dt).toFixed(4)) });
        cb.onMoveKeys(moves);
      }
      draw();
      return;
    }
    if (box) { box.x1 = x; box.y1 = y; draw(); return; }
    canvas.style.cursor = hitKey(x, y) >= 0 ? 'ew-resize' : (y < RULER_H + 4 ? 'pointer' : 'default');
  };

  const onUp = (ev: PointerEvent): void => {
    const c = cb.clip();
    if (box && c) {
      const lo = Math.min(box.x0, box.x1), hi = Math.max(box.x0, box.x1);
      if (hi - lo > 3) {
        sel = [];
        for (let i = 0; i < c.keys.length; i++) { const x = xOf(c.keys[i]!.t); if (x >= lo && x <= hi) sel.push(i); }
        cb.onSelectionChange(sel);
      }
    }
    box = null; dragging = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* */ }
    draw();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(host);
  resize();

  return {
    draw,
    selection: () => sel.slice(),
    setSelection(s) { sel = s.slice(); draw(); },
    resize() { resize(); draw(); },
    dispose() {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.remove();
    },
  };
}

// ── Операции над ключами, которые нужны панели (чистые, тестируемые) ─────────────────────────────
/** Сдвинуть/переставить ключи по новым временам, сохранив порядок. Возвращает новый порядок индексов. */
export function moveKeys(keys: Keyframe[], moves: { index: number; t: number }[]): void {
  for (const m of moves) { const k = keys[m.index]; if (k) k.t = Math.max(0, m.t); }
  keys.sort((a, b) => a.t - b.t);
}

/** Задать форму перехода выделенным ключам. */
export function setInterp(keys: Keyframe[], sel: readonly number[], interp: Interp, ease?: [number, number, number, number]): void {
  for (const i of sel) {
    const k = keys[i]; if (!k) continue;
    k.interp = interp;
    if (interp === 'ease' && ease) k.ease = [...ease] as [number, number, number, number];
    if (interp !== 'ease') delete k.ease;
  }
}

/** Растянуть/сжать выделенный диапазон по времени вокруг его начала. */
export function scaleKeys(keys: Keyframe[], sel: readonly number[], factor: number): void {
  if (sel.length < 2) return;
  const times = sel.map((i) => keys[i]!.t);
  const t0 = Math.min(...times);
  for (const i of sel) { const k = keys[i]!; k.t = Math.max(0, +(t0 + (k.t - t0) * factor).toFixed(4)); }
  keys.sort((a, b) => a.t - b.t);
}
