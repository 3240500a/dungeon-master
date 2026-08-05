/**
 * Кастом-поле `monsters[].spawnCurve` — редактор кривой веса спавна по ТИРАМ ГЛУБИНЫ (график:
 * горизонталь = тир глубины/этажи, вертикаль = вес спавна). Гибрид: пусто = авто по силовому тиру
 * монстра (столбец `weights[tier]` из depth-tiers); «Ручная кривая» → тянешь N точек мышью (оверрайд).
 * «Авто» очищает оверрайд. Значение — массив длины = числу тиров глубины (или пусто).
 */

type PowerTier = 'weak' | 'medium' | 'strong' | 'boss';
interface DepthTier {
  name: string; fromFloor: number; toFloor: number;
  weights: Record<PowerTier, number>;
}

const TIER_COL: Record<PowerTier, string> = { weak: '#5dcaa5', medium: '#5aa0e8', strong: '#e0894a', boss: '#d98cae' };

/** Рендер редактора кривой глубины. `tier` — силовой тир монстра (для авто-шаблона), `tiers` — depth-tiers. */
export function renderSpawnCurve(
  value: unknown,
  onChange: (v: unknown) => void,
  tier: PowerTier,
  tiers: DepthTier[],
): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'border:1px solid #2c2c3a;border-radius:6px;padding:8px;margin:4px 0;background:#0f0f16';

  if (!tiers.length) {
    box.textContent = 'Нет тиров глубины (depth-tiers) — настрой их на вкладке «Монстры: тиры глубины».';
    box.style.color = '#9aa'; box.style.fontSize = '12px';
    return box;
  }

  const N = tiers.length;
  const col = TIER_COL[tier] ?? '#5aa0e8';
  const auto = tiers.map((t) => t.weights[tier] ?? 0);
  const bandLabel = (t: DepthTier): string => (t.toFloor >= 900 ? `${t.fromFloor}+` : `${t.fromFloor}–${t.toFloor}`);

  // Текущий рабочий массив: оверрайд (длина N) или авто-копия.
  let over: number[] | null = Array.isArray(value) && value.length === N ? value.map(Number) : null;

  const W = 600, H = 210, L = 40, R = 588, T = 14, B = 176;
  const PW = R - L, PH = B - T;
  const yMax = Math.max(100, Math.ceil(Math.max(...auto, ...(over ?? []), 0) / 10) * 10);
  const X = (i: number): number => L + (N === 1 ? PW / 2 : (i / (N - 1)) * PW);
  const Y = (w: number): number => T + (1 - w / yMax) * PH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.style.cssText = 'display:block;touch-action:none;user-select:none';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap';
  const btnAuto = mkBtn('Авто (по тиру)');
  const btnMan = mkBtn('Ручная кривая');
  const hint = document.createElement('span');
  hint.style.cssText = 'font-size:11px;color:#9aa;flex:1;min-width:120px';
  head.append(btnAuto, btnMan, hint);
  box.append(head, svg);

  function curve(): number[] { return over ?? auto; }

  function render(): void {
    const man = over != null;
    const v = curve();
    const esc = (s: string): string => s;
    let s = '';
    tiers.forEach((t, i) => {
      const x = X(i);
      if (i % 2) s += `<rect x="${(x - PW / (N - 1) / 2).toFixed(1)}" y="${T}" width="${(PW / (N - 1)).toFixed(1)}" height="${PH}" fill="#ffffff" opacity="0.03"/>`;
      s += `<text x="${x.toFixed(1)}" y="${T - 2}" text-anchor="middle" fill="#8890a0" font-size="10">Т${i + 1}</text>`;
      s += `<text x="${x.toFixed(1)}" y="${B + 14}" text-anchor="middle" fill="#8890a0" font-size="10">${esc(bandLabel(t))}</text>`;
    });
    for (let g = 0; g <= yMax; g += yMax / 4) {
      s += `<line x1="${L}" y1="${Y(g).toFixed(1)}" x2="${R}" y2="${Y(g).toFixed(1)}" stroke="#2c2c3a" stroke-dasharray="2 4"/>`;
      s += `<text x="${L - 5}" y="${(Y(g) + 3).toFixed(1)}" text-anchor="end" fill="#6b6b7a" font-size="10">${Math.round(g)}</text>`;
    }
    const pathOf = (a: number[]): string => a.map((w, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(w).toFixed(1)).join(' ');
    if (man) s += `<path d="${pathOf(auto)}" fill="none" stroke="${col}" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.4"/>`;
    s += `<path d="${pathOf(v)}" fill="none" stroke="${col}" stroke-width="2.5"/>`;
    v.forEach((w, i) => {
      s += `<circle data-i="${i}" cx="${X(i).toFixed(1)}" cy="${Y(w).toFixed(1)}" r="6" fill="${man ? col : '#0f0f16'}" stroke="${col}" stroke-width="2" style="cursor:${man ? 'ns-resize' : 'default'}"/>`;
      s += `<text x="${X(i).toFixed(1)}" y="${(Y(w) - 9).toFixed(1)}" text-anchor="middle" fill="#c8c8d0" font-size="10">${Math.round(w)}</text>`;
    });
    svg.innerHTML = s;
    btnAuto.style.background = man ? '#2c2c3a' : '#3a4a5a';
    btnMan.style.background = man ? '#3a4a5a' : '#2c2c3a';
    hint.textContent = man
      ? 'Ручной режим: тяни точки. Пунктир — авто-кривая тира.'
      : `Авто по тиру «${tier}». «Ручная кривая» — дотюнить точками.`;
  }

  btnAuto.onclick = (): void => { over = null; onChange([]); render(); };
  btnMan.onclick = (): void => { over = auto.slice(); onChange(over.slice()); render(); };

  let di = -1;
  svg.addEventListener('pointerdown', (e) => {
    const t = e.target as SVGElement;
    const idx = t.getAttribute && t.getAttribute('data-i');
    if (idx != null && over) { di = +idx; svg.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (di < 0 || !over) return;
    const r = svg.getBoundingClientRect();
    const sy = ((e.clientY - r.top) / r.height) * H;
    over[di] = Math.max(0, Math.min(yMax, Math.round((1 - (sy - T) / PH) * yMax)));
    onChange(over.slice());
    render();
  });
  window.addEventListener('pointerup', () => { di = -1; });

  render();
  return box;
}

function mkBtn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = 'padding:4px 10px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:12px';
  return b;
}
