import { ConfigRegistry, sweepHitsToKill, DEFAULT_BUILD, type SweepCell, type BotTier, type BotStyle } from '@dm/shared';

/**
 * Вкладка «Свипы»: сетка уровень×монстр → хитмап ударов-до-смерти (цель 5-6 зелёным). Гоняет реальный
 * микро-бой (тот же движок) на уровне-адекватном боте. Сразу видно, где баланс вылетает из цели.
 */

let classId = '';
let lmin = 5, lmax = 80, lstep = 15;
let runs = 6, depthOff = 0;
let tier: BotTier = 'rotation';
let style: BotStyle = 'balanced';
let rarity: 'normal' | 'magic' | 'rare' | 'unique' = 'normal';
let metric: 'hits' | 'death' | 'ttk' = 'hits';
let monSel: Set<string> | null = null;   // выбранные монстры-колонки (null = все включённые)
let cells: SweepCell[] | null = null;     // результат последнего свипа

const h = (tag: string, css: string, txt = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (txt) e.textContent = txt; return e; };
const INP = 'padding:4px 6px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px';
function regFromData(data: Record<string, unknown>): ConfigRegistry { const reg = new ConfigRegistry(); reg.loadAll(data); return reg; }

function num(val: number, on: (n: number) => void, w = 58): HTMLInputElement {
  const i = document.createElement('input'); i.type = 'number'; i.value = String(val); i.style.cssText = INP + `;width:${w}px`;
  i.addEventListener('change', () => on(Number(i.value) || 0)); return i;
}
function sel(val: string, opts: [string, string][], on: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select'); s.style.cssText = INP;
  for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === val) o.selected = true; s.appendChild(o); }
  s.addEventListener('change', () => on(s.value)); return s;
}
function field(label: string, ctrl: HTMLElement): HTMLElement { const w = h('div', 'display:flex;flex-direction:column;gap:3px'); w.append(h('label', 'font-size:11px;color:#9aa', label), ctrl); return w; }

/** Цвет ячейки по числу ударов-до-смерти: 5-6 зелёный (цель), <5 к оранжевому (быстро), >6 к красному (долго). */
function hitsColor(x: number): string {
  if (!x) return '#20202a';
  if (x >= 5 && x <= 6) return '#2f7d4f';
  if (x < 5) { const t = Math.min(1, (5 - x) / 4); return `rgb(${Math.round(150 + 60 * t)},${Math.round(120 - 40 * t)},${Math.round(50)})`; } // amber→оранж
  const t = Math.min(1, (x - 6) / 10); return `rgb(${Math.round(120 + 70 * t)},${Math.round(110 - 70 * t)},${Math.round(45 - 20 * t)})`; // жёлто→красный
}
function rateColor(x: number): string { const t = Math.min(1, Math.max(0, x)); return `rgb(${Math.round(40 + 130 * t)},${Math.round(120 - 90 * t)},${Math.round(60 - 20 * t)})`; }
function ttkColor(x: number): string { const t = Math.min(1, x / 20); return `rgb(${Math.round(40 + 120 * t)},${Math.round(110 - 70 * t)},${Math.round(60 - 20 * t)})`; }

function cellDisplay(c: SweepCell): { txt: string; color: string; tip: string } {
  const tip = `ур.${c.level} · ${c.monsterId}\nударов: ${c.hitsToKill.toFixed(1)} (p10 ${c.hitsP10.toFixed(1)}–p90 ${c.hitsP90.toFixed(1)})\nTTK ${c.ttkSec.toFixed(1)}с · убил ${Math.round(c.killRate * 100)}% · погиб ${Math.round(c.deathRate * 100)}%\nисх.DPS ${Math.round(c.dpsOut)}`;
  if (metric === 'death') return { txt: `${Math.round(c.deathRate * 100)}%`, color: rateColor(c.deathRate), tip };
  if (metric === 'ttk') return { txt: c.ttkSec.toFixed(1), color: ttkColor(c.ttkSec), tip };
  return { txt: c.killRate < 0.5 ? '∞' : c.hitsToKill.toFixed(1), color: c.killRate < 0.5 ? '#5a2a6a' : hitsColor(c.hitsToKill), tip };
}

export function renderSweepPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const reg = regFromData(data);
  const classes = reg.get('classes');
  if (!classId || !classes.some((c) => c.id === classId)) classId = classes[0]?.id ?? '';
  const monsters = reg.get('monsters').filter((m) => m.enabled !== false);
  if (!monSel) monSel = new Set(monsters.slice(0, 12).map((m) => m.id)); // дефолт: первые 12 включённых

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 10px', '🔥 Свипы баланса (хитмап ударов-до-смерти)'));

  // ── Панель управления ──
  const ctl = h('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#14141c;margin-bottom:12px');
  ctl.append(
    field('Класс', sel(classId, classes.map((c) => [c.id, c.name] as [string, string]), (v) => { classId = v; })),
    field('Ур. от', num(lmin, (v) => { lmin = v; })),
    field('до', num(lmax, (v) => { lmax = v; })),
    field('шаг', num(lstep, (v) => { lstep = Math.max(1, v); }, 46)),
    field('Глуб.смещ.', num(depthOff, (v) => { depthOff = v; }, 52)),
    field('Прогонов', num(runs, (v) => { runs = Math.max(1, v); }, 52)),
    field('Стиль', sel(style, [['clear', 'зачистка'], ['balanced', 'сбаланс.'], ['rush', 'раш']], (v) => { style = v as BotStyle; })),
    field('Мастерство', sel(tier, [['basic', 'базовый'], ['kite', '+кайт'], ['potions', '+зелья'], ['rotation', 'полный']], (v) => { tier = v as BotTier; })),
    field('Редкость моба', sel(rarity, [['normal', 'обычный'], ['magic', 'магич.'], ['rare', 'редкий'], ['unique', 'уник']], (v) => { rarity = v as typeof rarity; })),
    field('Метрика', sel(metric, [['hits', 'удары-до-смерти'], ['death', 'смертность'], ['ttk', 'TTK, сек']], (v) => { metric = v as typeof metric; renderSweepPage(page, data); })),
  );
  const runBtn = document.createElement('button');
  runBtn.textContent = '▶ Прогнать свип';
  runBtn.style.cssText = 'padding:8px 14px;cursor:pointer;background:#2a4a2a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:13px';
  ctl.appendChild(field(' ', runBtn));
  page.appendChild(ctl);

  // ── Выбор монстров-колонок ──
  const monBox = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:8px 10px;background:#14141c;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center');
  monBox.appendChild(h('span', 'font-size:11px;color:#9aa;margin-right:4px', 'Монстры-колонки:'));
  for (const m of monsters) {
    const on = monSel!.has(m.id);
    const chip = document.createElement('button');
    chip.textContent = m.name;
    chip.style.cssText = `padding:2px 8px;cursor:pointer;border-radius:10px;font-size:11px;border:1px solid ${on ? '#3c7a60' : '#2c2c3a'};background:${on ? '#22402f' : '#1c1c26'};color:${on ? '#cfe' : '#9aa'}`;
    chip.addEventListener('click', () => { if (monSel!.has(m.id)) monSel!.delete(m.id); else monSel!.add(m.id); renderSweepPage(page, data); });
    monBox.appendChild(chip);
  }
  page.appendChild(monBox);

  const out = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#161620;overflow:auto');
  out.innerHTML = cells ? '' : '<div style="color:#666">Настрой параметры и нажми «Прогнать свип». Гоняет реальный микро-бой на уровне-адекватном боте (тот же движок, что игра).</div>';
  if (cells) out.appendChild(heatmap(reg, cells));
  page.appendChild(out);

  runBtn.addEventListener('click', () => {
    out.innerHTML = '<div style="color:#8a8a9a">Считаю свип…</div>';
    setTimeout(() => {
      try {
        const levels: number[] = []; for (let l = lmin; l <= lmax; l += lstep) levels.push(l);
        const monsterIds = monsters.filter((m) => monSel!.has(m.id)).map((m) => m.id);
        const t0 = performance.now();
        cells = sweepHitsToKill(reg, { classId, levels, monsterIds, build: DEFAULT_BUILD, tier, style, runs, seed: 1, depthOffset: depthOff, rarity });
        out.innerHTML = `<div style="color:#8a8a9a;font-size:12px;margin-bottom:8px">${levels.length} ур × ${monsterIds.length} моб × ${runs} прогонов · ${Math.round(performance.now() - t0)} мс · цель <span style="color:#5dcaa5">5–6 ударов</span></div>`;
        out.appendChild(heatmap(reg, cells));
      } catch (e) { out.innerHTML = `<div style="color:#ff8080">Ошибка: ${(e as Error).message}</div>`; }
    }, 20);
  });
}

/** Таблица-хитмап: строки=уровни, колонки=монстры. */
function heatmap(reg: ConfigRegistry, data: SweepCell[]): HTMLElement {
  const nameOf = new Map(reg.get('monsters').map((m) => [m.id, m.name]));
  const levels = [...new Set(data.map((c) => c.level))].sort((a, b) => a - b);
  const monIds = [...new Set(data.map((c) => c.monsterId))];
  const by = new Map(data.map((c) => [`${c.level}|${c.monsterId}`, c]));

  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:collapse;font-size:12px';
  const thead = document.createElement('tr');
  thead.appendChild(h('th', 'padding:4px 8px;text-align:right;color:#9aa;position:sticky;left:0;background:#161620', 'ур.\\моб'));
  for (const id of monIds) thead.appendChild(h('th', 'padding:4px 6px;color:#b8b8c8;font-weight:600;writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;height:70px', nameOf.get(id) ?? id));
  tbl.appendChild(thead);

  for (const lvl of levels) {
    const tr = document.createElement('tr');
    tr.appendChild(h('td', 'padding:3px 8px;text-align:right;color:#caa64b;font-weight:600;position:sticky;left:0;background:#161620', `${lvl}`));
    for (const id of monIds) {
      const c = by.get(`${lvl}|${id}`);
      const td = document.createElement('td');
      if (!c) { td.style.cssText = 'background:#20202a'; tr.appendChild(td); continue; }
      const d = cellDisplay(c);
      td.textContent = d.txt;
      td.title = d.tip;
      td.style.cssText = `padding:4px 8px;text-align:center;color:#f0f0f0;background:${d.color};border:1px solid #10101a;min-width:38px;font-variant-numeric:tabular-nums`;
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  const wrap = h('div', 'overflow:auto');
  wrap.appendChild(tbl);
  wrap.appendChild(h('div', 'font-size:11px;color:#8a8a9a;margin-top:8px', metric === 'hits' ? '● 5–6 зелёный = цель · оранжевый = слишком быстро (<5) · красный = слишком долго (>6) · ∞ = не убил (killRate<50%). Наведи на ячейку — детали.' : metric === 'death' ? '● зелёный = 0% смертей → красный = высокая смертность.' : '● TTK: зелёный быстро → красный долго.'));
  return wrap;
}
