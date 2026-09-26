import {
  CRAFT_SLOT_LIST, anatomyOf, axisOf, balanceAxisOf, bladeStats, clampStep, craftTiers, craftWeapon, familiesOf, formOf, keySlotOf,
  keyVariantsByBase, matchWhen, meltReturn, partById, typesRow, variantsFor, rollAffixes, createRng,
  type ConfigRegistry, type CraftInput, type Item, type PartSet, type SaveState, type CraftSlot, type WeaponPart,
} from '@dm/shared';
import { cardWith } from '@dm/client/modules/town/craftPanel.js';
import { craftDataRev, fightCheck, sandboxHero, type CraftSandbox } from './craft.js';

/**
 * «▦ Сетка баланса» — проверка инвариантов ГДД на ТЕКУЩИХ данных (docs/CRAFT_WEAPONS.md §16, §22).
 * Правишь шаги осей в «Баланс → Ковка», варианты в «Ковка → Детали» или правила имён в «Ковка →
 * Типы» — возвращаешься сюда и видишь, не сломалось ли. Формула считается мгновенно; бой
 * (`simulateMicroFight`) — по кнопке.
 *
 * ⚠ Все замеры идут при ФИКСИРОВАННОЙ базе: смена ключевой детали — это смена типа (другой чертёж),
 * а не надбавка, поэтому ключ перебирается только внутри своей базы.
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
let lastRev = -1;

const inputOf = (sb: CraftSandbox): CraftInput => ({ weaponClass: sb.win!.weaponClass, hands: sb.win!.hands, parts: structuredClone(sb.win!.parts) });

/**
 * Ось варианта для таблиц — та, что считает ядро (`axisOf`): у клинка с геометрией выведенная из замера
 * (§26), ручное число у него задаёт только вид заглушки. Рядом — разброс от ширины, если он не ×1.
 */
function axisTag(reg: ConfigRegistry, p: WeaponPart): string {
  const a = Math.round(axisOf(reg, p) * 100) / 100;
  const b = bladeStats(reg, p);
  const spread = b && b.spread !== 1 ? ` ×${b.spread.toFixed(2)}` : '';
  return `<span style="color:#777" title="${b ? 'ось по длине в вилке · разброс от ширины (§26)' : 'ось из данных'}">${a > 0 ? '+' : ''}${a}${spread}</span>`;
}

/**
 * Сборка текущего окна с подменой одного гнезда — на ТОЙ ЖЕ ступени вещи (`atTier`): у новой формы
 * может быть другое окно материалов, и без фиксации замер мерил бы сдвиг ступени, а не форму.
 */
function variantItem(reg: ConfigRegistry, sb: CraftSandbox, slot: CraftSlot, p: WeaponPart): Item | undefined {
  const input = inputOf(sb);
  input.parts[slot] = { id: p.id, step: clampStep(p, input.parts[slot].step) };
  return craftWeapon(reg, input, { atTier: craftWeapon(reg, inputOf(sb)).tier }).item;
}

/** Правила имён класса, которые ни на одной сборке не срабатывают первыми (затенены верхними). */
export function deadNameRules(reg: ConfigRegistry, cls: string): string[] {
  const row = typesRow(reg, cls);
  const anat = anatomyOf(reg, cls);
  if (!row || !anat) return [];
  const first = new Set<string>();
  for (const h2 of familiesOf(reg, cls)) {
    const pools = CRAFT_SLOT_LIST.map((s) => variantsFor(reg, cls, s, h2));
    for (const a of pools[0]!) for (const b of pools[1]!) for (const c of pools[2]!) for (const d of pools[3]!) {
      const ps: PartSet = { strike: a, grip: b, bind: c, head: d };
      const r = row.names.find((x) => x.enabled !== false && matchWhen(anat, x.when, h2, ps));
      if (r) first.add(r.id);
    }
  }
  return row.names.filter((r) => r.enabled !== false && !first.has(r.id)).map((r) => r.id);
}

export function renderCraftGrid(main: HTMLElement, reg: ConfigRegistry, sb: CraftSandbox, save: SaveState): void {
  const w = sb.win!;
  // Ревизия данных — в ключе: правка ручек во вкладке «Клинки» обязана сбросить прогон боя и частоты форм.
  const rev = craftDataRev();
  const key = `${rev}|${JSON.stringify(w.parts)}|${w.hands}|${sb.heroClass}|${sb.level}|${sb.preset}`;
  if (key !== lastKey) { gripFight = null; lastKey = key; }
  if (rev !== lastRev) { formFreq = null; lastRev = rev; }
  const pv = craftWeapon(reg, inputOf(sb));
  const base = reg.get('items.base').find((b) => b.id === pv.type?.baseId);
  const keySlot = keySlotOf(reg, w.weaponClass);
  const tierName = pv.tier !== undefined ? craftTiers(reg)[pv.tier]?.name ?? '' : '';
  main.append(h('div', 'color:#aaa;font-size:12px;margin-bottom:10px', `Проверяется сборка из окна ковки: <b style="color:#e39a3c">${pv.type?.name ?? '—'}</b> (база ${base?.name ?? '—'}), ${tierName}. Герой: уровень ${sb.level}, ${sb.preset}. Поменяй сборку во вкладке «Ковка».`));

  // ── Лампочки ──
  const lamps = card(main, 'Инварианты ГДД — на текущих данных');
  const lamp = (ok: boolean, text: string, detail: string): void => {
    const r = h('div', 'display:flex;gap:8px;align-items:flex-start;margin:3px 0');
    r.append(h('span', `width:10px;height:10px;border-radius:50%;margin-top:3px;flex:none;background:${ok ? '#8aa84a' : '#c85a48'}`));
    r.append(h('span', '', `<b>${text}</b><br><span style="color:#888;font-size:11px">${detail}</span>`));
    lamps.append(r);
  };

  // 1. Разброс ДПС ударной части по конверту — реальной цепочкой статов. Ключ — только формы своей базы.
  const strikes = keySlot === 'strike'
    ? keyVariantsByBase(reg, w.weaponClass, w.hands).find((g) => g.baseId === base?.id)?.variants ?? []
    : variantsFor(reg, w.weaponClass, 'strike', w.hands);
  const heat: number[][] = [];
  let worst = 0;
  strikes.forEach(() => heat.push([]));
  // ⭐ Ось — та, что считает ядро: у клинков с геометрией место по длине в вилке (§26). Крайних ±1 у
  // такой базы может не быть (вилка заполнена неровно), поэтому лампа меряет ФАКТИЧЕСКИЙ разброс форм,
  // а эталоном берёт форму с осью ближе всего к нулю — какой бы она ни была.
  const axes = strikes.map((p) => axisOf(reg, p));
  const minAbs = Math.min(...axes.map(Math.abs));
  const refIdx = axes.findIndex((a) => Math.abs(a) === minAbs);
  for (const D of D_GRID) for (const S of S_GRID) {
    const hero = sandboxHero(reg, { ...sb, bonusDmg: D, bonusSpd: S });
    const dps = strikes.map((p) => { const it = variantItem(reg, sb, 'strike', p); return it ? cardWith(reg, hero, it).dps : 0; });
    const ref = dps[refIdx] || 1;
    dps.forEach((v, i) => heat[i]!.push(v / ref));
    const pos = dps.filter((v) => v > 0);
    if (pos.length) worst = Math.max(worst, Math.max(...pos) / Math.min(...pos) - 1);
  }
  // Сколько разброса дают сами оси: (1 + урон·a)(1 − скорость·a) на крайних ФАКТИЧЕСКИХ осях. Остаток замера
  // сверх этого — округление чисел базы (в т.ч. разведённых шириной клинка) и плоская скорость базы.
  const ks = reg.get('balance').craft.strike;
  const byAxis = axes.map((a) => (1 + ks.damagePct * a) * (1 - ks.attackSpeed * a));
  const expect = byAxis.length ? Math.max(...byAxis) / Math.min(...byAxis) - 1 : 0;
  const geomN = strikes.filter((p) => bladeStats(reg, p)).length;
  const axRange = axes.length ? `${Math.min(...axes).toFixed(2)}…${Math.max(...axes).toFixed(2)}` : '—';
  lamp(worst <= 0.08, `Разброс ДПС между формами ударной части: ${(worst * 100).toFixed(1)} % (порог 8 %)`,
    `Худшая клетка конверта «бонус урона 0.3…1.5 × бонус скорости 0.05…0.6» (§4), база фиксирована. Считается теми же функциями, что у боя. ` +
    `Оси форм ${axRange}${geomN ? ` (${geomN} из ${strikes.length} — из геометрии клинка, §26)` : ''}; по одним осям ≈ ${(expect * 100).toFixed(1)} %.`);

  // 2. Держак площадь-нейтрален.
  const grips = variantsFor(reg, w.weaponClass, 'grip', w.hands);
  let areaDev = 0;
  const areaBase = (base as { arcMult?: number; reachMult?: number } | undefined);
  const a0 = (areaBase?.arcMult ?? 1) * (areaBase?.reachMult ?? 1) ** 2;
  const isMelee = (base as { attackType?: string } | undefined)?.attackType === 'melee';
  for (const g of grips) { const it = variantItem(reg, sb, 'grip', g); if (it && isMelee) areaDev = Math.max(areaDev, Math.abs(((it.arcMult ?? 1) * (it.reachMult ?? 1) ** 2) / a0 - 1)); }
  lamp(!isMelee || areaDev < 0.005, isMelee ? `Площадь взмаха держака постоянна: отклонение ${(areaDev * 100).toFixed(2)} %` : 'Держак стрелкового/магического — только вид', isMelee ? '`дуга × дальность²` одна у всех вариантов (§5.1). Прежняя пара давала +27.6 %.' : 'У снаряда нет честной оси геометрии (§5.2): дальность — константа, радиус — скрытый ДПС.');

  // 3. Неключевые гнёзда 2–4 не двигают ДПС формулы.
  const refDps = pv.item ? cardWith(reg, save, pv.item).dps : 1;
  let shift = 0;
  for (const slot of (['grip', 'bind', 'head'] as const).filter((s) => s !== keySlot)) for (const p of variantsFor(reg, w.weaponClass, slot, w.hands)) {
    const it = variantItem(reg, sb, slot, p);
    if (it) shift = Math.max(shift, Math.abs(cardWith(reg, save, it).dps / refDps - 1));
  }
  lamp(shift < 1e-6, `Неключевые гнёзда не двигают ДПС формулы: ${(shift * 100).toFixed(2)} %`, 'Замок «одна ось ДПС внутри типа» (§3.2). ⚠ Статус оголовья двигает ДПС в БОЮ — это меряет вкладка «Ковка → настоящий бой».');

  // 4. Форма ёмкости не выходит за дроп.
  let formOk = true;
  for (let s = 0; s <= 5; s++) for (let a = -1; a <= 1; a += 0.25) { const f = formOf(s, a); if (f.prefix > 3 || f.suffix > 3) formOk = false; }
  lamp(formOk, 'Ёмкость не выходит за лучший дроп: не больше 3 на сторону', 'Форма 3+3 дроп не даёт вовсе — значит и ковка (§6.1).');

  // 5. Переплавка не печатает деньги.
  const price = new Map(reg.get('craft-materials').map((m) => [m.id, m.sellPrice]));
  const val = (c: Record<string, number>): number => Object.entries(c).reduce((s, [id, n]) => s + (price.get(id) ?? 0) * n, 0);
  let meltOk = true; let worstMelt = '';
  for (let k = 1; k <= 5; k++) {
    const input = inputOf(sb);
    for (const s of CRAFT_SLOT_LIST) { const p = partById(reg, input.parts[s].id); if (p) input.parts[s].step = clampStep(p, k); }
    const r = craftWeapon(reg, input);
    if (!r.ok || !r.item || !r.cost) continue;
    const m = val(meltReturn(reg, r.item)), c = val(r.cost.materials);
    if (m >= c) { meltOk = false; worstMelt = `ст.${k}: вернула ${m} при цене ${c}`; }
  }
  lamp(meltOk, 'Сковать и переплавить — всегда в минус', meltOk ? 'Проверено на «вся вещь из ступени 1…5» этой сборки (§13).' : `⚠ ${worstMelt}`);

  // 6. Мёртвые правила имён.
  const dead = deadNameRules(reg, w.weaponClass);
  lamp(!dead.length, dead.length ? `Затенённые правила имён: ${dead.join(', ')}` : 'Правила имён класса: мёртвых нет', 'Правила проверяются сверху вниз, первое совпадение побеждает. Правило, которое ни на одной сборке не срабатывает первым, — мёртвое: его закрыло верхнее (§3.3).');

  // ── Тепловая карта ──
  const hm = card(main, 'Ударная часть × конверт билдов — индекс ДПС (эталон = 100)', 'Строки — формы от тяжёлых к лёгким (у ключевого гнезда — только формы текущей базы), столбцы — бонус урона D и бонус скорости S. Зелёный — в пределах ±4 %, жёлтый — до ±8 %, красный — хуже.');
  const tbl = h('table', 'border-collapse:collapse;font-family:monospace;font-size:11px');
  const hr = h('tr', '');
  hr.append(h('td', 'padding:3px 6px;color:#888', ''));
  for (const D of D_GRID) for (const S of S_GRID) hr.append(h('td', 'padding:3px 4px;color:#888;text-align:center;white-space:nowrap', `D${D}<br>S${S}`));
  tbl.append(hr);
  strikes.forEach((p, i) => {
    const r = h('tr', '');
    r.append(h('td', 'padding:3px 6px;font-family:sans-serif;white-space:nowrap', `${p.name} ${axisTag(reg, p)}`));
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
    const it = variantItem(reg, sb, 'grip', g);
    const c = it ? cardWith(reg, save, it) : undefined;
    const f = gripFight?.find((x) => x.name === g.name);
    gt.innerHTML += `<tr><td>${g.name} ${axisTag(reg, g)}</td><td style="text-align:right;font-family:monospace">${c?.rangePx?.toFixed(0) ?? '—'}</td><td style="text-align:right;font-family:monospace">${c?.arcDeg?.toFixed(0) ?? '—'}</td><td style="text-align:right;font-family:monospace">${c?.area ? '×' + c.area.toFixed(3) : '—'}</td><td style="text-align:right;font-family:monospace">${f ? f.dps.toFixed(1) : ''}</td><td style="text-align:right;font-family:monospace">${f ? f.hps.toFixed(2) : ''}</td></tr>`;
  }
  gc.append(gt);
  const gb = h('button', `${BTN};margin-top:8px`, isMelee ? 'Прогнать бой по пачке ×5 для каждого держака' : 'У стрелкового держак только вид');
  (gb as HTMLButtonElement).disabled = !isMelee;
  gb.addEventListener('click', () => {
    gb.textContent = 'считаю…';
    setTimeout(() => {
      gripFight = grips.map((g) => { const it = variantItem(reg, sb, 'grip', g); const r = fightCheck(reg, save, it, sb.monsterId, 5, 8); return { name: g.name, dps: r.dps, hps: r.hitsPerSec }; });
      main.innerHTML = ''; renderCraftGrid(main, reg, sb, save);
    }, 20);
  });
  gc.append(gb);

  // ── Оголовье ──
  // ⭐ Рычаг оголовья — ТОЧКА БАЛАНСА вещи (§26): у клинка с геометрией это клинок и оголовье вместе,
  // поэтому то же оголовье на другом клинке даёт другой блок. Колонка «баланс» — число, которое ест ядро.
  const strikeSel = partById(reg, w.parts.strike.id);
  const hc = card(main, 'Оголовье: укус ↔ упор', 'Упор поднимает блок (у лука — стойкость к прерыванию), укус — статус своей грани. «Баланс» — точка баланса вещи: у клинка с геометрией клинок и оголовье вместе (§26), иначе ось оголовья. Стаки — по модели ОБЩЕГО таймера, как в бою.');
  const ht = h('table', 'border-collapse:collapse;font-size:12px;width:100%');
  ht.innerHTML = '<tr style="color:#888"><td></td><td style="text-align:right">баланс</td><td style="text-align:right">блок</td><td style="text-align:right">стойкость</td><td style="text-align:right">статус</td><td style="text-align:right">шанс</td><td style="text-align:right">стаков</td></tr>';
  for (const p of variantsFor(reg, w.weaponClass, 'head', w.hands)) {
    const it = variantItem(reg, sb, 'head', p);
    const c = it ? cardWith(reg, save, it) : undefined;
    const bal = strikeSel ? balanceAxisOf(reg, strikeSel, p) : p.axis;
    ht.innerHTML += `<tr><td>${p.name} ${axisTag(reg, p)}</td><td style="text-align:right;font-family:monospace">${bal > 0 ? '+' : ''}${bal.toFixed(2)}</td><td style="text-align:right;font-family:monospace">${c ? (c.block * 100).toFixed(1) + ' %' : '—'}</td><td style="text-align:right;font-family:monospace">${c ? (c.interruptResist * 100).toFixed(0) + ' %' : '—'}</td><td style="text-align:right">${c?.status?.name ?? '<span style="color:#c85a48">нет грани</span>'}</td><td style="text-align:right;font-family:monospace;color:${c?.status?.capped ? '#c85a48' : 'inherit'}">${c?.status ? (c.status.chance * 100).toFixed(1) + ' %' : ''}</td><td style="text-align:right;font-family:monospace">${c?.status ? c.status.avgStacks.toFixed(2) + ' / ' + c.status.maxStacks : ''}</td></tr>`;
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
