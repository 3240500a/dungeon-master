import {
  craftWeapon, formOf, materialBand, meltReturn, variantsFor, rollAffixes, createRng,
  type ConfigRegistry, type Item, type SaveState, type CraftSlot,
} from '@dm/shared';
import { cardWith } from '@dm/client/modules/town/craftPanel.js';
import { fightCheck, sandboxHero, type CraftSandbox } from './craft.js';

/**
 * «▦ Сетка баланса» — проверка инвариантов ГДД на ТЕКУЩИХ данных (docs/CRAFT_WEAPONS.md §16, §22).
 * Правишь шаги осей в «Баланс → Ковка» или варианты в «Ковка → Детали» — возвращаешься сюда и
 * видишь, не сломалось ли. Формула считается мгновенно; бой (`simulateMicroFight`) — по кнопке.
 */

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const BTN = 'padding:5px 10px;cursor:pointer;border-radius:5px;border:1px solid #3a3a4c;background:#1c1c26;color:#e8e8f0;font-size:12px';
const card = (parent: HTMLElement, title: string, hint = ''): HTMLElement => {
  const c = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px');
  c.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:4px', title));
  if (hint) c.append(h('div', 'color:#888;font-size:11px;margin-bottom:8px', hint));
  parent.append(c);
  return c;
};

/** Конверт билдов из §4: бонус урона × бонус скорости. */
const D_GRID = [0.3, 0.6, 0.9, 1.2, 1.5];
const S_GRID = [0.05, 0.2, 0.4, 0.6];

let gripFight: { name: string; dps: number; hps: number }[] | null = null;
let formFreq: { key: string; measured: number; config: number }[] | null = null;
let lastKey = '';

/** Сборка текущего окна с подменой одного гнезда. */
function variantItem(reg: ConfigRegistry, sb: CraftSandbox, slot: CraftSlot, id: string): Item | undefined {
  const w = sb.win!;
  return craftWeapon(reg, { baseId: w.baseId, tier: w.tier, step: w.step, parts: { ...w.parts, [slot]: id } }).item;
}

export function renderCraftGrid(main: HTMLElement, reg: ConfigRegistry, sb: CraftSandbox, save: SaveState): void {
  const w = sb.win!;
  const key = `${w.baseId}|${w.tier}|${w.step}|${JSON.stringify(w.parts)}|${sb.heroClass}|${sb.level}|${sb.preset}`;
  if (key !== lastKey) { gripFight = null; lastKey = key; }
  const base = reg.get('items.base').find((b) => b.id === w.baseId);
  main.append(h('div', 'color:#aaa;font-size:12px;margin-bottom:10px', `Проверяется сборка из окна ковки: <b style="color:#e39a3c">${base?.name ?? '—'}</b>, ${reg.get('item-tiers').find((_, i) => i === w.tier)?.name ?? ''}. Герой: уровень ${sb.level}, ${sb.preset}. Поменяй сборку во вкладке «Ковка».`));

  // ── Лампочки ──
  const lamps = card(main, 'Инварианты ГДД — на текущих данных');
  const lamp = (ok: boolean, text: string, detail: string): void => {
    const r = h('div', 'display:flex;gap:8px;align-items:flex-start;margin:3px 0');
    r.append(h('span', `width:10px;height:10px;border-radius:50%;margin-top:3px;flex:none;background:${ok ? '#8aa84a' : '#c85a48'}`));
    r.append(h('span', '', `<b>${text}</b><br><span style="color:#888;font-size:11px">${detail}</span>`));
    lamps.append(r);
  };

  // 1. Разброс ДПС ударной части по конверту — реальной цепочкой статов (makePlayerModel → weaponCard).
  const strikes = variantsFor(reg, w.weaponClass, 'strike');
  const heat: number[][] = [];
  let worst = 0;
  strikes.forEach(() => heat.push([]));
  for (const D of D_GRID) for (const S of S_GRID) {
    const hero = sandboxHero(reg, { ...sb, bonusDmg: D, bonusSpd: S });
    const dps = strikes.map((p) => { const it = variantItem(reg, sb, 'strike', p.id); return it ? cardWith(reg, hero, it).dps : 0; });
    const ref = dps[strikes.findIndex((p) => Math.abs(p.axis) === Math.min(...strikes.map((x) => Math.abs(x.axis))))] || 1;
    dps.forEach((v, i) => heat[i]!.push(v / ref));
    const pos = dps.filter((v) => v > 0);
    if (pos.length) worst = Math.max(worst, Math.max(...pos) / Math.min(...pos) - 1);
  }
  lamp(worst <= 0.08, `Разброс ДПС между вариантами ударной части: ${(worst * 100).toFixed(1)} % (порог 8 %)`, 'Худшая клетка конверта «бонус урона 0.3…1.5 × бонус скорости 0.05…0.6» (§4). Считается теми же функциями, что у боя.');

  // 2. Держак площадь-нейтрален.
  const grips = variantsFor(reg, w.weaponClass, 'grip');
  let areaDev = 0;
  const areaBase = (base as { arcMult?: number; reachMult?: number } | undefined);
  const a0 = (areaBase?.arcMult ?? 1) * (areaBase?.reachMult ?? 1) ** 2;
  const isMelee = (base as { attackType?: string } | undefined)?.attackType === 'melee';
  for (const g of grips) { const it = variantItem(reg, sb, 'grip', g.id); if (it && isMelee) areaDev = Math.max(areaDev, Math.abs(((it.arcMult ?? 1) * (it.reachMult ?? 1) ** 2) / a0 - 1)); }
  lamp(!isMelee || areaDev < 0.005, isMelee ? `Площадь взмаха держака постоянна: отклонение ${(areaDev * 100).toFixed(2)} %` : 'Держак стрелкового/магического — только вид', isMelee ? '`дуга × дальность²` одна у всех вариантов (§5.1). Прежняя пара давала +27.6 %.' : 'У снаряда нет честной оси геометрии (§5.2): дальность — константа, радиус — скрытый ДПС.');

  // 3. Гнёзда 2–4 не двигают ДПС формулы.
  const refDps = (() => { const it = variantItem(reg, sb, 'strike', w.parts.strike); return it ? cardWith(reg, save, it).dps : 1; })();
  let shift = 0;
  for (const slot of ['grip', 'bind', 'head'] as const) for (const p of variantsFor(reg, w.weaponClass, slot)) {
    const it = variantItem(reg, sb, slot, p.id);
    if (it) shift = Math.max(shift, Math.abs(cardWith(reg, save, it).dps / refDps - 1));
  }
  lamp(shift < 1e-6, `Держак, обвязка и оголовье не двигают ДПС формулы: ${(shift * 100).toFixed(2)} %`, 'Замок «одна ось ДПС» (§3.2). ⚠ Статус оголовья двигает ДПС в БОЮ — это меряет вкладка «Ковка → настоящий бой».');

  // 4. Форма ёмкости не выходит за дроп.
  let formOk = true;
  for (let s = 0; s <= 5; s++) for (let a = -1; a <= 1; a += 0.25) { const f = formOf(s, a); if (f.prefix > 3 || f.suffix > 3) formOk = false; }
  lamp(formOk, 'Ёмкость не выходит за лучший дроп: не больше 3 на сторону', 'Форма 3+3 дроп не даёт вовсе — значит и ковка (§6.1).');

  // 5. Переплавка не печатает деньги.
  const price = new Map(reg.get('craft-materials').map((m) => [m.id, m.sellPrice]));
  const val = (c: Record<string, number>): number => Object.entries(c).reduce((s, [id, n]) => s + (price.get(id) ?? 0) * n, 0);
  let meltOk = true; let worstMelt = '';
  for (let step = 1; step <= 5; step++) {
    const band = materialBand(step);
    for (let t = band.lo; t <= band.hi; t++) {
      const r = craftWeapon(reg, { baseId: w.baseId, tier: t, step, parts: w.parts });
      if (!r.ok || !r.item || !r.cost) continue;
      const m = val(meltReturn(reg, r.item)), c = val(r.cost.materials);
      if (m >= c) { meltOk = false; worstMelt = `t${t} ст.${step}: вернула ${m} при цене ${c}`; }
    }
  }
  lamp(meltOk, 'Сковать и переплавить — всегда в минус', meltOk ? 'Проверено на каждой паре «ступень × материал» этой базы (§13).' : `⚠ ${worstMelt}`);

  // ── Тепловая карта ──
  const hm = card(main, 'Ударная часть × конверт билдов — индекс ДПС (эталон = 100)', 'Строки — варианты от тяжёлых к лёгким, столбцы — бонус урона D и бонус скорости S. Зелёный — в пределах ±4 %, жёлтый — до ±8 %, красный — хуже.');
  const tbl = h('table', 'border-collapse:collapse;font-family:monospace;font-size:11px');
  const hr = h('tr', '');
  hr.append(h('td', 'padding:3px 6px;color:#888', ''));
  for (const D of D_GRID) for (const S of S_GRID) hr.append(h('td', 'padding:3px 4px;color:#888;text-align:center;white-space:nowrap', `D${D}<br>S${S}`));
  tbl.append(hr);
  strikes.forEach((p, i) => {
    const r = h('tr', '');
    r.append(h('td', 'padding:3px 6px;font-family:sans-serif;white-space:nowrap', `${p.name} <span style="color:#777">${p.axis > 0 ? '+' : ''}${p.axis}</span>`));
    for (const v of heat[i]!) {
      const d = Math.abs(v - 1);
      const bg = d <= 0.04 ? '#1f3320' : d <= 0.08 ? '#3a3418' : '#3a1f18';
      r.append(h('td', `padding:3px 4px;text-align:center;background:${bg}`, (v * 100).toFixed(0)));
    }
    tbl.append(r);
  });
  const wrapHm = h('div', 'overflow-x:auto'); wrapHm.append(tbl); hm.append(wrapHm);

  // ── Держак ──
  const gc = card(main, 'Держак: геометрия и бой по пачке из пяти', 'Площадь постоянна — значит по толпе держаки обязаны давать близкий ДПС. «Попаданий/с» показывает, сколько целей реально задевает взмах.');
  const gt = h('table', 'border-collapse:collapse;font-size:12px;width:100%');
  gt.innerHTML = '<tr style="color:#888"><td></td><td style="text-align:right">дальность, px</td><td style="text-align:right">дуга, °</td><td style="text-align:right">площадь</td><td style="text-align:right">ДПС в бою</td><td style="text-align:right">попаданий/с</td></tr>';
  for (const g of grips) {
    const it = variantItem(reg, sb, 'grip', g.id);
    const c = it ? cardWith(reg, save, it) : undefined;
    const f = gripFight?.find((x) => x.name === g.name);
    gt.innerHTML += `<tr><td>${g.name} <span style="color:#777">${g.axis > 0 ? '+' : ''}${g.axis}</span></td><td style="text-align:right;font-family:monospace">${c?.rangePx?.toFixed(0) ?? '—'}</td><td style="text-align:right;font-family:monospace">${c?.arcDeg?.toFixed(0) ?? '—'}</td><td style="text-align:right;font-family:monospace">${c?.area ? '×' + c.area.toFixed(3) : '—'}</td><td style="text-align:right;font-family:monospace">${f ? f.dps.toFixed(1) : ''}</td><td style="text-align:right;font-family:monospace">${f ? f.hps.toFixed(2) : ''}</td></tr>`;
  }
  gc.append(gt);
  const gb = h('button', `${BTN};margin-top:8px`, isMelee ? 'Прогнать бой по пачке ×5 для каждого держака' : 'У стрелкового держак только вид');
  (gb as HTMLButtonElement).disabled = !isMelee;
  gb.addEventListener('click', () => {
    gb.textContent = 'считаю…';
    setTimeout(() => {
      gripFight = grips.map((g) => { const it = variantItem(reg, sb, 'grip', g.id); const r = fightCheck(reg, save, it, sb.monsterId, 5, 8); return { name: g.name, dps: r.dps, hps: r.hitsPerSec }; });
      main.innerHTML = ''; renderCraftGrid(main, reg, sb, save);
    }, 20);
  });
  gc.append(gb);

  // ── Оголовье ──
  const hc = card(main, 'Оголовье: укус ↔ упор', 'Упор поднимает блок (у лука — стойкость к прерыванию), укус — статус своей грани. Стаки — по модели ОБЩЕГО таймера, как в бою.');
  const ht = h('table', 'border-collapse:collapse;font-size:12px;width:100%');
  ht.innerHTML = '<tr style="color:#888"><td></td><td style="text-align:right">блок</td><td style="text-align:right">стойкость</td><td style="text-align:right">статус</td><td style="text-align:right">шанс</td><td style="text-align:right">стаков</td></tr>';
  for (const p of variantsFor(reg, w.weaponClass, 'head')) {
    const it = variantItem(reg, sb, 'head', p.id);
    const c = it ? cardWith(reg, save, it) : undefined;
    ht.innerHTML += `<tr><td>${p.name} <span style="color:#777">${p.axis > 0 ? '+' : ''}${p.axis}</span></td><td style="text-align:right;font-family:monospace">${c ? (c.block * 100).toFixed(1) + ' %' : '—'}</td><td style="text-align:right;font-family:monospace">${c ? (c.interruptResist * 100).toFixed(0) + ' %' : '—'}</td><td style="text-align:right">${c?.status?.name ?? '<span style="color:#c85a48">нет грани</span>'}</td><td style="text-align:right;font-family:monospace;color:${c?.status?.over100 ? '#c85a48' : 'inherit'}">${c?.status ? (c.status.chance * 100).toFixed(1) + ' %' : ''}</td><td style="text-align:right;font-family:monospace">${c?.status ? c.status.avgStacks.toFixed(2) + ' / ' + c.status.maxStacks : ''}</td></tr>`;
  }
  hc.append(ht);

  // ── Частоты форм ──
  const fc = card(main, 'Цена формы ёмкости: замер против конфига', 'M = 1 / доля найденных редких с такой же или лучшей формой (§6.1). Замер — тем же `rollAffixes`, что у дропа, на текущих аффиксах.');
  const fb = h('button', BTN, 'Замерить на 20 000 бросков');
  fb.addEventListener('click', () => {
    fb.textContent = 'считаю…';
    setTimeout(() => { formFreq = measureForms(reg); main.innerHTML = ''; renderCraftGrid(main, reg, sb, save); }, 20);
  });
  fc.append(fb);
  if (formFreq) {
    const ft = h('table', 'border-collapse:collapse;font-size:12px;margin-top:8px;font-family:monospace');
    ft.innerHTML = '<tr style="color:#888"><td>форма</td><td style="text-align:right;padding-left:14px">замер M</td><td style="text-align:right;padding-left:14px">в конфиге</td><td style="text-align:right;padding-left:14px">расхождение</td></tr>' +
      formFreq.map((f) => { const d = f.config ? f.measured / f.config - 1 : 0; return `<tr><td>${f.key}</td><td style="text-align:right">${f.measured.toFixed(2)}</td><td style="text-align:right">${f.config.toFixed(2)}</td><td style="text-align:right;color:${Math.abs(d) <= 0.05 ? '#8aa84a' : '#e39a3c'}">${(d * 100).toFixed(1)} %</td></tr>`; }).join('');
    fc.append(ft);
  }

}

function measureForms(reg: ConfigRegistry): { key: string; measured: number; config: number }[] {
  const r = reg.get('rarities').find((x) => x.id === 'rare')!;
  const N = 20000;
  const rng = createRng(11);
  const cnt = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const a = rollAffixes(reg.get('affixes'), { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind: 'physical' }, 'rare',
      { minAffixes: r.minAffixes, maxAffixes: r.maxAffixes, maxPrefix: r.maxPrefix, maxSuffix: r.maxSuffix }, 40, rng);
    const kinds = new Map(a.map((x) => [x.affixId, x.kind]));
    const p = [...kinds.values()].filter((k) => k === 'prefix').length;
    const k = `${p}+${kinds.size - p}`;
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const cfg = reg.get('balance').craft.formMult;
  return Object.keys(cfg).map((key) => {
    const [P, S] = key.split('+').map(Number);
    let ge = 0; for (const [k, n] of cnt) { const [a, b] = k.split('+').map(Number); if (a! >= P! && b! >= S!) ge += n; }
    return { key, measured: ge ? N / ge : Infinity, config: cfg[key]! };
  });
}
