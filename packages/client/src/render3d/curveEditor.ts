/**
 * РЕДАКТОР КРИВОЙ ПЕРЕХОДА (Ф10) — безье-ручки вместо трёх кнопок-пресетов.
 *
 * Данные под это лежали в клипе с Ф1.2 (`Keyframe.interp` + `Keyframe.ease`), но крутить их можно было
 * только пресетами «плавно / резко / держать». Здесь ручки тянутся мышью, как в графе Blender/Cascadeur.
 *
 * ЧТО ИМЕННО РЕДАКТИРУЕТСЯ — важно не перепутать. У нас клип покадровый: ключ хранит ПОЗУ ЦЕЛИКОМ,
 * а не отдельные дорожки значений на кость. Поэтому кривая здесь — это РЕМАП ФАЗЫ интервала
 * (timing curve, `easeU`), общий для всех костей интервала, а не «значение кости во времени».
 * Пер-костные кривые потребовали бы другой модели данных (ключи на канал), и это осознанно не наша модель:
 * поза целиком — то, что редактор запекает и что переносимо между движками.
 *
 * Ось X — фаза интервала (0 = текущий ключ, 1 = следующий), ось Y — сколько пути пройдено.
 * Диагональ = linear. Ручки можно уводить за 0..1 по Y — это «отскок» (overshoot), `cubicBezier` его считает.
 *
 * Чистая часть (пресеты, попадание в ручку, клэмп перетаскивания) тестируется в node; канвас — тонкая обёртка.
 */
import { cubicBezier, EASE_INOUT, EASE_IN, EASE_OUT, type Keyframe } from './clipModel.js';

export type Ease = [number, number, number, number];

/** Готовые формы. `id` совпадает с подписью кнопки в тулбаре тайм-лайна, чтобы не плодить синонимы. */
export const CURVE_PRESETS: readonly { id: string; label: string; hint: string; ease: Ease }[] = [
  { id: 'inout', label: 'плавно', hint: 'мягкий старт и мягкая остановка (ease-in-out)', ease: EASE_INOUT },
  { id: 'in', label: 'разгон', hint: 'медленно стартует, влетает в следующий ключ (ease-in)', ease: EASE_IN },
  { id: 'out', label: 'торможение', hint: 'резко стартует, мягко тормозит (ease-out)', ease: EASE_OUT },
  { id: 'snap', label: 'рывок', hint: 'почти вся дистанция за первую треть — удар/щелчок', ease: [0.1, 0.9, 0.2, 1] },
  { id: 'anticip', label: 'замах', hint: 'уходит НАЗАД перед движением (anticipation)', ease: [0.6, -0.35, 0.3, 1] },
  { id: 'back', label: 'отскок', hint: 'перелетает цель и возвращается (overshoot)', ease: [0.3, 0, 0.4, 1.35] },
];

export const easeOfPreset = (id: string): Ease | null => {
  const p = CURVE_PRESETS.find((x) => x.id === id);
  return p ? ([...p.ease] as Ease) : null;
};

/** Ближайший пресет к заданным ручкам (для подсветки активной кнопки). `null` — ручки уведены вручную. */
export function matchPreset(e: Ease, tol = 0.02): string | null {
  for (const p of CURVE_PRESETS) if (p.ease.every((v, i) => Math.abs(v - e[i]!) <= tol)) return p.id;
  return null;
}

/** Запас по Y: ручку можно увести ЗА 0..1 (замах/отскок), и она обязана остаться видимой и хватаемой —
 *  иначе перетащил, она ушла под край панели, и обратно её уже не взять. */
export const EASE_Y_MIN = -0.35, EASE_Y_MAX = 1.35;

const HANDLE_R = 0.075;   // радиус попадания в ручку, в долях поля (поле нормировано 0..1 по обеим осям)

/** В какую ручку попали (0 = от текущего ключа, 1 = от следующего), −1 = мимо. Координаты нормированы. */
export function curveHitHandle(e: Ease, x: number, y: number, tol = HANDLE_R): 0 | 1 | -1 {
  const d0 = Math.hypot(x - e[0], y - e[1]), d1 = Math.hypot(x - e[2], y - e[3]);
  if (d0 <= tol && d0 <= d1) return 0;
  if (d1 <= tol) return 1;
  return -1;
}

/** Перетаскивание ручки → новые значения. X зажат в 0..1 (иначе кривая перестаёт быть функцией времени
 *  и `cubicBezier` не решится), Y свободен в разумных пределах — это и даёт замах/отскок. */
export function curveDrag(e: Ease, which: 0 | 1, x: number, y: number): Ease {
  const cx = Math.max(0, Math.min(1, +x.toFixed(3)));
  const cy = Math.max(EASE_Y_MIN, Math.min(EASE_Y_MAX, +y.toFixed(3)));
  const out: Ease = [...e] as Ease;
  if (which === 0) { out[0] = cx; out[1] = cy; } else { out[2] = cx; out[3] = cy; }
  return out;
}

/** Человекочитаемая подпись — чтобы в Простом режиме не показывать четыре числа. */
export function describeEase(e: Ease): string {
  const id = matchPreset(e, 0.05);
  if (id) return CURVE_PRESETS.find((p) => p.id === id)!.label;
  const enter = e[1] < e[0] ? 'мягкий вход' : 'резкий вход';
  const exit = e[3] > e[2] ? 'мягкий выход' : 'резкий выход';
  return `${enter}, ${exit}`;
}

/** Ручки ключа: то, что реально применится (у ключа без `ease` кривая = дефолтная плавная). */
export const easeOfKey = (k: Keyframe | undefined): Ease => ([...(k?.ease ?? EASE_INOUT)] as Ease);

// ── Панель (канвас) ───────────────────────────────────────────────────────────────────────────────
export interface CurveCallbacks {
  /** Ключ, чей ИСХОДЯЩИЙ интервал редактируем (кривая живёт на ключе, а не между ключами). */
  key(): Keyframe | null;
  /** Ручки изменились. `live` = идёт перетаскивание (не писать в историю/на сервер на каждый кадр). */
  onChange(ease: Ease, live: boolean): void;
  /** Показать позу на фазе `u` интервала — чтобы кривая было видно на манекене прямо при таскании. */
  onPreview?(u: number): void;
}
export interface CurvePanel { draw(): void; dispose(): void }

const PAD = 16;

export function makeCurvePanel(host: HTMLElement, cb: CurveCallbacks): CurvePanel {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:default;border-radius:3px';
  host.append(canvas);
  const ctx = canvas.getContext('2d')!;
  let w = 0, h = 0, drag: 0 | 1 | null = null;

  const fieldW = (): number => Math.max(1, w - PAD * 2);
  const fieldH = (): number => Math.max(1, h - PAD * 2);
  // Поле по Y охватывает EASE_Y_MIN..EASE_Y_MAX, а не 0..1: перелёт кривой остаётся внутри панели.
  const SPAN = EASE_Y_MAX - EASE_Y_MIN;
  const toPx = (x: number, y: number): [number, number] => [PAD + x * fieldW(), h - PAD - ((y - EASE_Y_MIN) / SPAN) * fieldH()];
  const toNorm = (px: number, py: number): [number, number] => [(px - PAD) / fieldW(), EASE_Y_MIN + ((h - PAD - py) / fieldH()) * SPAN];

  function resize(): void {
    // Мерим САМ канвас, а не host: у host есть рамка, и его border-box на 2px больше — координаты мыши
    // считались бы в одной системе, а рисование в другой (уезжание ручки под курсором на ~1%).
    const r = canvas.getBoundingClientRect();
    w = Math.max(80, r.width); h = Math.max(60, r.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(): void {
    { const r = canvas.getBoundingClientRect(); if (Math.abs(r.width - w) > 1 || Math.abs(r.height - h) > 1) resize(); }
    const k = cb.key();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14161e'; ctx.fillRect(0, 0, w, h);
    if (!k) {
      ctx.fillStyle = '#6b7180'; ctx.font = '11px monospace';
      ctx.fillText('нет кадра', PAD, h / 2);
      return;
    }
    // рамка = единичный квадрат 0..1 (а не всё поле): по ней видно, где кривая ПЕРЕЛЕТАЕТ цель
    ctx.strokeStyle = '#2a3040'; ctx.lineWidth = 1;
    { const [bx, by] = toPx(0, 1), [ex, ey] = toPx(1, 0); ctx.strokeRect(bx, by, ex - bx, ey - by); }
    ctx.setLineDash([3, 3]); ctx.beginPath();
    { const [x0, y0] = toPx(0, 0), [x1, y1] = toPx(1, 1); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.beginPath(); ctx.rect(1, 1, w - 2, h - 2); ctx.clip();   // кривая не выплёскивается за панель

    const e = easeOfKey(k);
    const stepped = k.interp === 'step';
    const flat = !k.interp || k.interp === 'linear' || k.interp === 'fixed';

    // сама кривая
    ctx.strokeStyle = stepped ? '#ffcf66' : flat ? '#8fb7ff' : '#9ae6a0';
    ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      const v = stepped ? (u >= 1 ? 1 : 0) : flat ? u : cubicBezier(e[0], e[1], e[2], e[3], u);
      const [px, py] = toPx(u, v);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    if (!stepped && !flat) {                                  // ручки только когда они на что-то влияют
      ctx.lineWidth = 1;
      for (const [ax, ay, hx, hy, col] of [[0, 0, e[0], e[1], '#ff8c3a'], [1, 1, e[2], e[3], '#4a8cff']] as const) {
        const [x0, y0] = toPx(ax, ay), [x1, y1] = toPx(hx, hy);
        ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x1, y1, 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    ctx.fillStyle = '#6b7180'; ctx.font = '9px monospace';
    ctx.fillText(stepped ? 'держать' : flat ? 'линейно' : describeEase(e), PAD + 2, 10);
  }

  const local = (ev: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return toNorm(ev.clientX - r.left, ev.clientY - r.top);
  };

  const onDown = (ev: PointerEvent): void => {
    const k = cb.key(); if (!k || k.interp === 'step') return;
    const [x, y] = local(ev);
    const hit = curveHitHandle(easeOfKey(k), x, y);
    if (hit === -1) return;
    drag = hit;
    canvas.setPointerCapture(ev.pointerId);
  };
  const onMove = (ev: PointerEvent): void => {
    const k = cb.key(); if (!k) return;
    const [x, y] = local(ev);
    if (drag === null) { canvas.style.cursor = curveHitHandle(easeOfKey(k), x, y) >= 0 ? 'grab' : 'default'; return; }
    cb.onChange(curveDrag(easeOfKey(k), drag, x, y), true);
    cb.onPreview?.(Math.max(0, Math.min(1, x)));
    draw();
  };
  const onUp = (ev: PointerEvent): void => {
    const k = cb.key();
    if (drag !== null && k) cb.onChange(easeOfKey(k), false);   // финальная запись — одна, а не на каждый кадр таскания
    drag = null;
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
    dispose(): void {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.remove();
    },
  };
}
