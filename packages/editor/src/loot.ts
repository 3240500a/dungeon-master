import {
  ConfigRegistry, generateRunPlan, generateFloor, resolveMonsterPool, spawnPacksEl, createRng,
  newBotSave, effectiveLevel, rollTierLevel, pickTierClamped, depthRarityBoost, salvageFromMonster,
  forgeGold, type Item, type Rng,
} from '@dm/shared';

/**
 * Вкладка «Дроп»: что, где и сколько выпадает — ТАБЛИЦАМИ, на текущей (правленой) копии конфигов.
 *
 * ⚠ Ни одного числа здесь не считается своей формулой. Монстров даёт `spawnPacksEl` на настоящем
 * сгенерированном этаже, сырьё — `salvageFromMonster`, ступень вещи — `rollTierLevel` +
 * `pickTierClamped`, кривую глубины — `depthRarityBoost`. Иначе редактор завёл бы второй источник
 * правды и начал бы расходиться с игрой ровно в тот момент, когда по нему что-нибудь решают.
 */

function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

// ── Состояние страницы (переживает перерисовки) ──────────────────────────────
interface Knobs { power: number; depth: number; diffId: string; floors: number }
let knobs: Knobs | null = null;

const CSS = {
  card: 'border:1px solid #2c2c3a;border-radius:8px;padding:12px 14px;background:#15151d;margin-bottom:12px',
  h: 'font-size:14px;font-weight:600;color:#e8e8f0;margin:0 0 2px',
  sub: 'font-size:11px;color:#8a8a9a;margin:0 0 10px',
  td: 'padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums',
  th: 'padding:3px 8px;text-align:right;color:#8a8a9a;font-weight:500;font-size:11px',
};

const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};

/** Замер одного зачищенного этажа: всё, что он платит. Считается настоящей генерацией. */
interface FloorPay {
  monsters: number; lvlLo: number; lvlHi: number;
  items: number; intact: number; broken: number; fromChest: number;
  mats: number[]; potions: number; gold: number;
  chests: number;
}

function measureFloor(reg: ConfigRegistry, k: Knobs): FloorPay {
  const bal = reg.get('balance');
  const loot = bal.loot;
  const biomes = reg.get('biomes');
  const mats = reg.get('craft-materials');
  const tierOfId = new Map(mats.map((m) => [m.id, m.tier]));
  const gearById = (id: string) => reg.get('monster-gear').find((g) => g.id === id);
  const known = (id: string) => mats.some((c) => c.id === id && c.enabled);
  const diff = reg.get('difficulties').find((d) => d.id === k.diffId) ?? reg.get('difficulties')[0]!;
  const chestTiers = reg.get('chests').filter((c) => c.enabled !== false && (c.weight ?? 0) > 0);
  const wTot = chestTiers.reduce((s, c) => s + (c.weight ?? 0), 0) || 1;
  const perChest = chestTiers.reduce((s, c) => s + (c.weight ?? 0) * ((c.itemsMin + c.itemsMax) / 2), 0) / wTot;

  const out: FloorPay = {
    monsters: 0, lvlLo: Infinity, lvlHi: 0, items: 0, intact: 0, broken: 0, fromChest: 0,
    mats: [0, 0, 0, 0], potions: 0, gold: 0, chests: 0,
  };
  const rng: Rng = createRng(k.depth * 7919 + Math.round(k.power) * 31 + 1);
  let floors = 0;
  for (let seed = 1; seed <= Math.max(1, k.floors); seed++) {
    const plan = generateRunPlan(reg, { templateId: reg.get('run-templates')[0]!.id, biomeId: biomes[0]!.id, tier: k.diffId, seed, modifiers: [] });
    // ⚠ Узла типа 'town' в графе нет вовсе — этажи отличаются НАЛИЧИЕМ floorSpec.
    const node = plan.nodes.find((n) => n.floorSpec);
    if (!node?.floorSpec) continue;
    const layout = generateFloor(node.floorSpec, reg.get('room-prefabs'), undefined, undefined,
      { tiers: reg.get('chests'), perFloor: loot.chestsPerFloor });
    const biome = biomes.find((b) => b.id === node.biomeId) ?? biomes[0]!;
    const list = spawnPacksEl(reg, layout, k.depth, k.diffId, createRng((node.floorSpec.seed >>> 0) || 1),
      k.power, resolveMonsterPool(biome, Math.max(1, Math.min(k.depth, 20))), node.floorSpec.packDensity, node.floorSpec.floorId);
    floors++;
    out.chests += layout.chests.length;
    for (const s of list) {
      const def = s.def ?? s;
      out.monsters++;
      out.lvlLo = Math.min(out.lvlLo, def.level);
      out.lvlHi = Math.max(out.lvlHi, def.level);
      if (rng.chance(loot.goldChance)) out.gold += Math.max(1, Math.round(rng.int(1, 5 + def.level * 2) * diff.goldMult));
      if (rng.chance(loot.potions.chance)) out.potions++;
      if (rng.chance(loot.materials.chance)) {
        const g = salvageFromMonster(def.gearRolls, gearById, rng,
          { rarity: def.rarity, rarityTier: bal.salvage.rarityTier, knownMaterial: known });
        for (const [id, n0] of Object.entries(g)) {
          const raw = n0 * loot.materials.mult, whole = Math.floor(raw);
          const n = whole + (rng.chance(raw - whole) ? 1 : 0);
          const t = tierOfId.get(id) ?? 1;
          out.mats[t] = (out.mats[t] ?? 0) + n;
        }
      }
      if (rng.chance(loot.dropChance)) {
        out.items++;
        if (rng.chance(loot.trophyChance) && rng.chance(loot.brokenChance)) out.broken++; else out.intact++;
      }
    }
  }
  const f = Math.max(1, floors);
  out.monsters /= f; out.items /= f; out.intact /= f; out.broken /= f;
  out.potions /= f; out.gold /= f; out.chests /= f;
  out.mats = out.mats.map((x) => x / f);
  out.fromChest = out.chests * perChest;
  out.items += out.fromChest; out.intact += out.fromChest;   // содержимое сундука ЦЕЛОЕ
  if (out.lvlLo === Infinity) out.lvlLo = 0;
  return out;
}

const n1 = (x: number): string => (Math.round(x * 10) / 10).toString();
const n0 = (x: number): string => Math.round(x).toString();

function table(head: string[], rows: (string | number)[][], hi?: (r: number) => boolean): HTMLElement {
  const t = el('table', 'border-collapse:collapse;font-size:12px;color:#d8d8e4');
  const hr = el('tr');
  for (const [i, h] of head.entries()) hr.appendChild(el('th', `${CSS.th}${i === 0 ? ';text-align:left' : ''}`, h));
  t.appendChild(hr);
  rows.forEach((r, ri) => {
    const tr = el('tr', hi?.(ri) ? 'background:#26263a' : '');
    r.forEach((c, ci) => tr.appendChild(el('td', `${CSS.td}${ci === 0 ? ';text-align:left;color:#8a8a9a' : ''}`, String(c))));
    t.appendChild(tr);
  });
  return t;
}

/** Карточка «за зачищенный этаж» — главный ответ на «что и сколько». */
function cardFloor(reg: ConfigRegistry, p: FloorPay): HTMLElement {
  const mats = reg.get('craft-materials');
  const nameOfTier = (t: number): string => mats.find((m) => m.tier === t)?.name.replace(/\s.*/, '') ?? `т${t}`;
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'За зачищенный этаж'));
  box.append(el('div', CSS.sub, `монстров ${n0(p.monsters)}, уровень ${p.lvlLo}–${p.lvlHi} · сундуков ${n1(p.chests)}`));
  box.append(table(
    ['', 'всего', 'из них'],
    [
      ['Вещей', n1(p.items), `целых ${n1(p.intact)} · сломанных ${n1(p.broken)}`],
      ['  с монстров', n1(p.items - p.fromChest), `сломанных ${n1(p.broken)}`],
      ['  из сундуков', n1(p.fromChest), 'все целые'],
      ['Сырья, ед.', n0(p.mats[1]! + p.mats[2]! + p.mats[3]!),
        `${nameOfTier(1)} ${n0(p.mats[1]!)} · ${nameOfTier(2)} ${n0(p.mats[2]!)} · ${nameOfTier(3)} ${n0(p.mats[3]!)}`],
      ['Колб', n1(p.potions), ''],
      ['Золота', n0(p.gold), ''],
    ],
  ));
  return box;
}

/** Правило №1: какая доля убийств платит хоть чем-то. */
function cardRule1(reg: ConfigRegistry): HTMLElement {
  const l = reg.get('balance').loot;
  const nothing = (1 - l.dropChance) * (1 - l.materials.chance) * (1 - l.goldChance) * (1 - l.potions.chance);
  const pay = 1 - nothing;
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'Правило №1: убийство продолжает платить'));
  box.append(el('div', CSS.sub, 'Суммарная частота наград не должна падать — меняться может только их ВИД.'));
  const bar = el('div', 'height:14px;border-radius:7px;background:#23232f;overflow:hidden;margin-bottom:8px');
  bar.appendChild(el('div', `height:100%;width:${(pay * 100).toFixed(1)}%;background:${pay > 0.55 ? '#4a8f4a' : '#a34141'}`));
  box.append(bar);
  box.append(el('div', `font-size:12px;color:${pay > 0.55 ? '#8fc08f' : '#e08a8a'}`,
    `${(pay * 100).toFixed(0)} % убийств платят хоть чем-то${pay > 0.55 ? '' : '  ⚠ ниже порога 55 %'}`));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:6px',
    `золото ${(l.goldChance * 100).toFixed(0)} % · сырьё ${(l.materials.chance * 100).toFixed(0)} %`
    + ` · вещь ${(l.dropChance * 100).toFixed(0)} % · колба ${(l.potions.chance * 100).toFixed(0)} %`));
  return box;
}

/**
 * ЗОЛОТО ПРОТИВ ФИКСИРОВАННЫХ ЦЕН. Монета масштабируется уровнем монстра
 * (`rng.int(1, 5 + ур·2)`, среднее = ур + 3), а кузница стоит СТОЛЬКО ЖЕ на любом уровне.
 * Значит покупательная способность растёт линейно, и таблица показывает это прямо в улучшениях
 * за этаж — числом, а не ощущением.
 */
function cardGold(reg: ConfigRegistry, p: FloorPay, k: Knobs): HTMLElement {
  const bal = reg.get('balance');
  const loot = bal.loot;
  const diff = reg.get('difficulties').find((d) => d.id === k.diffId) ?? reg.get('difficulties')[0]!;
  const upg = bal.forgePrices.upgradeTier;
  const mons = Math.max(1, Math.round(p.monsters));
  const levels = [5, 10, 25, 50, 75, 100, 150];
  const rows = levels.map((L) => {
    const perKill = ((1 + 5 + L * 2) / 2) * diff.goldMult;      // среднее той же формулы
    const perFloor = mons * loot.goldChance * perKill;
    return [L, n0(perKill), n0(perFloor), (perFloor / Math.max(1, upg)).toFixed(1)];
  });
  const near = levels.reduce((b, L) => (Math.abs(L - p.lvlHi) < Math.abs(b - p.lvlHi) ? L : b), levels[0]!);
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'Золото: масштабируется уровнем монстра, цены — нет'));
  box.append(el('div', CSS.sub,
    `выпадает с ${(loot.goldChance * 100).toFixed(0)} % убийств, сумма 1…(5 + ур·2) × ${diff.goldMult}`
    + ` · этаж считается по ${mons} монстрам`));
  box.append(table(['ур. моба', 'за убийство', 'за этаж', 'улучшений за этаж'], rows, (ri) => levels[ri] === near));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:8px',
    `⚠ Все стоки ФИКСИРОВАННЫЕ: улучшение ${upg}, перекатка ${bal.forgePrices.rerollAffix},`
    + ` починка ${bal.forgePrices.repairBroken}, сброс ${bal.respecCost}. Приход растёт с уровнем, расход — нет,`
    + ' поэтому последняя колонка и есть настоящая инфляция золота.'));
  return box;
}

/**
 * ЦЕНЫ КУЗНИЦЫ по ступени и редкости — та же `forgeGold`, которой платит сервер.
 * В скобках — сколько таких работ оплачивает ОДИН этаж на текущем уровне монстров: именно эта
 * величина и должна стоять колом по всей лестнице, иначе золото обесценивается к эндгейму.
 */
function cardForge(reg: ConfigRegistry, p: FloorPay): HTMLElement {
  const tiers = [...reg.get('item-tiers')].sort((x, y) => x.minItemLevel - y.minItemLevel);
  const base = reg.get('items.base').find((b) => b.kind === 'weapon')!;
  const inc = Math.max(1, p.gold);
  const mk = (tierId: string, rarity: string): Item =>
    ({ baseId: base.id, tier: tierId, rarity, baseStats: [], itemLevel: 1 } as unknown as Item);
  const cell = (tierId: string, rarity: string, op: 'upgrade' | 'repair' | 'reroll'): string => {
    const c = forgeGold(reg, mk(tierId, rarity), op);
    return `${c} (${(inc / c).toFixed(1)})`;
  };
  const rows = tiers.map((t) => [
    t.name,
    cell(t.id, 'normal', 'upgrade'), cell(t.id, 'rare', 'upgrade'),
    cell(t.id, 'normal', 'repair'), cell(t.id, 'rare', 'repair'),
    cell(t.id, 'normal', 'reroll'),
  ]);
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'Кузница: цена по ступени и редкости'));
  box.append(el('div', CSS.sub,
    'цена = база × reqMult(ступень) × priceMult(редкость) · в скобках — сколько таких работ оплачивает этаж'
    + ` (доход ${n0(p.gold)})`));
  box.append(table(
    ['ступень', 'улучшить об.', 'улучшить редк.', 'починить об.', 'починить редк.', 'перекатать об.'],
    rows));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:8px',
    '⭐ Смотреть надо на числа В СКОБКАХ: они должны быть примерно одинаковы по всей лестнице. '
    + 'Разъедутся — значит золото либо обесценилось к эндгейму, либо стало непосильным в начале. '
    + '⚠ Сырьё по ступени НЕ масштабируется намеренно: его приход от уровня не зависит вовсе, '
    + 'а плоский доход требует плоской цены.'));
  return box;
}

/** Распределение ступеней вещи по уровню монстра + ручник. */
function cardTiers(reg: ConfigRegistry, curLvl: number): HTMLElement {
  const W = reg.get('balance').loot.tierWindow;
  const tiers = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const levels = [10, 25, 40, 55, 70, 80, 100, 150, 200, 500];
  const N = 4000;
  const rows = levels.map((m) => {
    const rng = createRng(m * 31 + 7);
    const cnt = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const id = pickTierClamped(tiers, rollTierLevel(m, W, rng), 't0', 't6')!.id;
      cnt.set(id, (cnt.get(id) ?? 0) + 1);
    }
    return [m, ...tiers.map((t) => {
      const p = (100 * (cnt.get(t.id) ?? 0)) / N;
      return p === 0 ? '·' : p < 0.5 ? '<1' : p.toFixed(0);
    })];
  });
  const near = levels.reduce((b, m) => (Math.abs(m - curLvl) < Math.abs(b - curLvl) ? m : b), levels[0]!);
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'Ступень вещи по уровню монстра, %'));
  box.append(el('div', CSS.sub,
    `окно [${W.low}·ур … ур+${W.over}], смещение ${W.bias} · ручник: softCap ${W.softCap}, k ${W.softK}, hardCap ${W.hardCap}`));
  box.append(table(['ур. моба', ...tiers.map((t) => t.name)], rows, (ri) => levels[ri] === near));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:8px',
    'Подсвечена строка, ближайшая к текущему уровню монстров. Верхняя ступень обязана оставаться редкой '
    + 'на любой глубине — иначе бесконечный забег станет её фермой.'));
  return box;
}

/**
 * Сырьё по глубине: настоящая генерация на каждую строку, поэтому результат КЭШИРУЕТСЯ.
 * Пересчитывать восемь глубин на каждое движение ползунка — секунды залипания, а таблица от
 * ползунков и не зависит: состав решает редкость монстров, а её решает глубина.
 */
let depthCache: { rows: (string | number)[][]; power: number } | null = null;

function depthMatRows(reg: ConfigRegistry, power: number): (string | number)[][] {
  if (depthCache && depthCache.power === power) return depthCache.rows;
  const c = reg.get('balance').loot.depthRarity;
  const rows = [5, 15, 25, 50, 100, 200, 400, 1000].map((d) => {
    const p = measureFloor(reg, { power, depth: d, diffId: 'normal', floors: 3 });
    const tot = p.mats[1]! + p.mats[2]! + p.mats[3]!;
    return [d, depthRarityBoost(d, c).toFixed(1),
      n0(p.mats[1]!), n0(p.mats[2]!), n0(p.mats[3]!), n0(tot),
      `${tot > 0 ? Math.round((100 * (p.mats[2]! + p.mats[3]!)) / tot) : 0} %`];
  });
  depthCache = { rows, power };
  return rows;
}

/** Кривая «глубина → редкость монстров», через неё — ступень сырья и трофеев. */
function cardDepth(reg: ConfigRegistry, curDepth: number): HTMLElement {
  const c = reg.get('balance').loot.depthRarity;
  const depths = [5, 15, 25, 50, 100, 200, 400, 1000];
  const rows = depths.map((d) => {
    const b = depthRarityBoost(d, c);
    const rare = Math.min(c.maxRare, 0.03 * b);
    let magic = 0.12 * b;
    const room = Math.max(0, 1 - c.minNormal);
    if (rare + magic > room) magic = Math.max(0, room - rare);
    return [d, b.toFixed(1), `${(magic * 100).toFixed(0)} %`, `${(rare * 100).toFixed(0)} %`,
      `${((1 - magic - rare) * 100).toFixed(0)} %`];
  });
  const near = depths.reduce((b, d) => (Math.abs(d - curDepth) < Math.abs(b - curDepth) ? d : b), depths[0]!);
  const box = el('div', CSS.card);
  box.append(el('div', CSS.h, 'Глубина → редкость монстров (задел под бесконечный забег)'));
  box.append(el('div', CSS.sub,
    `до ${c.freeDepth}-го этажа множитель 1 · шаг ${c.step}, степень ${c.k}, потолок ${1 + c.maxBoost}`
    + ` · обычных не меньше ${(c.minNormal * 100).toFixed(0)} %`));
  box.append(table(['глубина', 'буст', 'магических', 'редких', 'обычных'], rows, (ri) => depths[ri] === near));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:8px',
    'Ступень сырья задаёт редкость надетой вещи — поэтому глубина улучшает и сырьё, и трофеи одной ручкой.'));
  return box;
}

/** Сырьё за этаж по глубине — та же кривая, но уже в единицах материалов. */
function cardDepthMats(reg: ConfigRegistry, power: number, curDepth: number, onRefresh: () => void): HTMLElement {
  const mats = reg.get('craft-materials');
  const nameOfTier = (t: number): string => mats.find((m) => m.tier === t)?.name.replace(/\s.*/, '') ?? `т${t}`;
  const rows = depthMatRows(reg, power);
  const depths = rows.map((r) => Number(r[0]));
  const near = depths.reduce((b, d) => (Math.abs(d - curDepth) < Math.abs(b - curDepth) ? d : b), depths[0]!);
  const box = el('div', CSS.card);
  const head = el('div', 'display:flex;justify-content:space-between;align-items:baseline;gap:12px');
  head.append(el('div', CSS.h, 'Сырьё за этаж по глубине'));
  const btn = el('button', 'font-size:11px;padding:3px 10px;border-radius:6px;border:1px solid #2c2c3a;background:#1c1c26;color:#b8b8c8;cursor:pointer', '↻ пересчитать');
  btn.addEventListener('click', () => { depthCache = null; onRefresh(); });
  head.append(btn);
  box.append(head);
  box.append(el('div', CSS.sub, 'настоящая генерация по 3 этажа на строку, поэтому кэшируется — после правки баланса жми «пересчитать»'));
  box.append(table(
    ['глубина', 'буст', nameOfTier(1), nameOfTier(2), nameOfTier(3), 'всего', 'высоких'],
    rows, (ri) => depths[ri] === near));
  box.append(el('div', 'font-size:11px;color:#8a8a9a;margin-top:8px',
    '⭐ Главное здесь — колонка «всего»: она почти не меняется. Глубина покупает КАЧЕСТВО, а не количество, '
    + 'поэтому фармить её ради «побольше» бессмысленно — это и есть защита бесконечного забега от фермы.'));
  return box;
}

// ── Страница ─────────────────────────────────────────────────────────────────
export function renderLootPage(host: HTMLElement, data: Record<string, unknown>): void {
  const reg = regFromData(data);
  if (!knobs) {
    const save = newBotSave(reg, reg.get('classes')[0]!.id);
    knobs = { power: effectiveLevel(save, reg.get('balance').power).total, depth: 5, diffId: 'normal', floors: 6 };
  }
  const k = knobs;
  host.innerHTML = '';
  const wrap = el('div', 'padding:4px 8px 24px;overflow-y:auto');

  wrap.append(el('h3', 'margin:0 0 2px;color:#e8e8f0;font-size:16px', '🎁 Дроп: что и сколько выпадает'));
  wrap.append(el('div', 'font-size:11px;color:#8a8a9a;margin-bottom:12px',
    'Считается ТЕМИ ЖЕ функциями, что и игра, на текущей правленой копии конфигов. Правь баланс — таблицы едут следом.'));

  // Ручки.
  const bar = el('div', 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:14px');
  const slider = (label: string, min: number, max: number, val: number, set: (v: number) => void): HTMLElement => {
    const g = el('div', 'display:flex;gap:8px;align-items:center');
    g.append(el('span', 'font-size:12px;color:#8a8a9a', label));
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.value = String(val);
    inp.style.cssText = 'width:150px';
    const out = el('b', 'font-size:12px;color:#e8e8f0;min-width:32px', String(val));
    inp.addEventListener('input', () => { out.textContent = inp.value; });
    inp.addEventListener('change', () => { set(Number(inp.value)); renderLootPage(host, data); });
    g.append(inp, out);
    return g;
  };
  bar.append(slider('мощь героя', 1, 100, k.power, (v) => { k.power = v; }));
  bar.append(slider('глубина', 1, 20, k.depth, (v) => { k.depth = v; }));
  const sel = document.createElement('select');
  sel.style.cssText = 'background:#1c1c26;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:6px;padding:4px 8px';
  for (const d of reg.get('difficulties')) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name; o.selected = d.id === k.diffId;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { k.diffId = sel.value; renderLootPage(host, data); });
  const g = el('div', 'display:flex;gap:8px;align-items:center');
  g.append(el('span', 'font-size:12px;color:#8a8a9a', 'сложность'), sel);
  bar.append(g);
  wrap.append(bar);

  const pay = measureFloor(reg, k);
  wrap.append(cardFloor(reg, pay));
  wrap.append(cardRule1(reg));
  wrap.append(cardGold(reg, pay, k));
  wrap.append(cardForge(reg, pay));
  wrap.append(cardTiers(reg, pay.lvlHi));
  wrap.append(cardDepth(reg, k.depth));
  wrap.append(cardDepthMats(reg, k.power, k.depth, () => renderLootPage(host, data)));
  host.appendChild(wrap);
}
