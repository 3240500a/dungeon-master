import {
  ConfigRegistry, resolveActive, socketsOpen, insertById, insertFits, activeAbilityOf,
  newBotSave, playerSnapshot, attackByType, shapeSkillPacket, abilityElementOf, abilityRankMult,
  itemFromBase, retierItem, emptyPacket, DAMAGE_TYPES,
  type SaveState, type ResolvedActive, type Item, type DamageType,
} from '@dm/shared';

/**
 * Вкладка «Сборка скила» — предпросмотр модульного скила: носитель + вставки → что вышло.
 *
 * ГЛАВНОЕ ЗДЕСЬ НЕ ИНТЕРФЕЙС, А ЧИСЛА. Считает не «своя формула редактора», а `resolveActive` —
 * тот самый шов, которым пользуется сервер. Иначе дизайнер балансировал бы по одним числам,
 * а игра играла бы по другим; тест `skillBuild.test.ts` сверяет предпросмотр с сейвом, собранным
 * АВТОРИТЕТНЫМИ командами (`socketInsert`), — то есть с тем, что реально получит игрок.
 *
 * Вторая работа страницы — показывать ОШИБКИ РАЗДАЧИ: вставка без узла-донора в игре недостижима,
 * и увидеть это надо здесь, а не по жалобе игрока.
 */

let nodeId = '';
let rank = 12;
let insRank = 1;
/** Конкретное оружие в руках: по нему считается УРОН, а не только «влезает ли вставка». */
let weaponBaseId = '';
let weaponTier = '';
let charLevel = 30;
let slots: string[] = [];

const h = (tag: string, css: string, txt = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (txt) e.textContent = txt; return e; };
const INP = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';
function regFromData(data: Record<string, unknown>): ConfigRegistry { const reg = new ConfigRegistry(); reg.loadAll(data); return reg; }

function sel(val: string, opts: [string, string][], on: (v: string) => void, w = ''): HTMLSelectElement {
  const s = document.createElement('select'); s.style.cssText = INP + (w ? `;width:${w}` : '');
  for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === val) o.selected = true; s.appendChild(o); }
  s.addEventListener('change', () => on(s.value)); return s;
}
function field(label: string, ctrl: HTMLElement): HTMLElement {
  const w = h('div', 'display:flex;flex-direction:column;gap:3px'); w.append(h('label', 'font-size:11px;color:#9aa', label), ctrl); return w;
}

// ── Чистая часть: её же зовёт тест ───────────────────────────────────────────
/** Есть ли у вставки узел-донор. Без него открыть её в игре нечем — вставка мертва. */
export function insertReachable(reg: ConfigRegistry, insertId: string): boolean {
  return reg.get('skill-tree').nodes.some((n) => n.effect.grantsInsert === insertId);
}

/**
 * Назначить донора КАЖДОЙ вставке в этой копии реестра (свободные пассивные узлы). Нужно ради
 * авторинга: заводя новую вставку, дизайнер должен видеть её числа СРАЗУ, не отвлекаясь на то,
 * к какому узлу её потом привязать. О самой недостижимости он узнаёт из отдельной плашки —
 * это другая проблема, и смешивать их значит прятать обе.
 *
 * ТОЛЬКО ДЛЯ ОДНОРАЗОВОГО РЕДАКТОРСКОГО РЕЕСТРА: он собирается заново на каждый рендер,
 * поэтому мутация никуда не утекает. В игре и на сервере так делать нельзя.
 */
export function ensureDonors(reg: ConfigRegistry): void {
  const nodes = reg.get('skill-tree').nodes;
  const have = new Set(nodes.map((n) => n.effect.grantsInsert).filter(Boolean) as string[]);
  const spare = nodes.filter((n) => !n.effect.active && !n.effect.grantsInsert);
  let k = 0;
  for (const ins of reg.get('skill-inserts')) {
    if (have.has(ins.id)) continue;
    const node = spare[k++];
    if (!node) return;                 // свободных узлов не осталось — редкость, но молча не падаем
    node.effect.grantsInsert = ins.id;
  }
}

/**
 * Синтетический сейв «идеального игрока»: ранг в носителе, ранг в КАЖДОМ узле-доноре (чтобы
 * дизайнеру не приходилось поимённо открывать вставки) и заданные гнёзда.
 *
 * Открывать всех доноров разом — не поблажка: раздача проверяется отдельно (`insertReachable`),
 * а здесь считается БАЛАНС сборки, и мешать одно с другим значит прятать обе проблемы.
 */
export function previewSave(reg: ConfigRegistry, carrier: string, carrierRank: number, ids: readonly string[], insRank = 1): SaveState {
  const skills: Record<string, number> = { [carrier]: carrierRank };
  for (const n of reg.get('skill-tree').nodes) if (n.effect.grantsInsert) skills[n.id] = insRank;
  return { skills, sockets: { [carrier]: [...ids] } } as unknown as SaveState;
}

/** Предпросмотр сборки: «до» (голый носитель) и «после» (с вставками) — оба из общего шва. */
export function previewBuild(reg: ConfigRegistry, carrier: string, carrierRank: number, ids: readonly string[], insRank = 1):
  { base: NonNullable<ReturnType<typeof activeAbilityOf>>; resolved: ResolvedActive } | undefined {
  const base = activeAbilityOf(reg, carrier);
  if (!base) return undefined;
  const resolved = resolveActive(reg, previewSave(reg, carrier, carrierRank, ids, insRank), carrier);
  return resolved ? { base, resolved } : undefined;
}

// ── Разбор различий «до → после» ─────────────────────────────────────────────
/**
 * Плоский снимок способности: путь поля → значение. Различия ищем ОБЩИМ сравнением, а не списком
 * интересных полей: у способности их под сорок и они прибывают, а забытое поле в предпросмотре —
 * это молча неверные числа у дизайнера.
 */
function flatten(o: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (o === null || o === undefined) return out;
  if (typeof o !== 'object') { out[prefix] = typeof o === 'number' ? String(Math.round(o * 1000) / 1000) : String(o); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const LABEL: Record<string, string> = {
  manaCost: 'Стоимость', cooldown: 'Откат', damageMult: 'Множитель урона', element: 'Стихия',
  convertPct: 'Конверсия', addElementPct: 'Добавка стихии', multScope: 'На что множитель',
  arcMult: 'Дуга', rangeMult: 'Дальность', radius: 'Радиус', count: 'Снарядов', spread: 'Разброс',
  hits: 'Ударов', pierce: 'Пробитие', speed: 'Скорость', knockback: 'Отброс', stunSec: 'Стан, с',
  knockdownChance: 'Сбить с ног', 'ailment.kind': 'Статус', 'ailment.chance': 'Шанс статуса',
  'ailment.mag': 'Сила статуса', 'ailment.durationMs': 'Длит. статуса, мс', 'ailment.maxStacks': 'Стаков',
  windupSec: 'Замах, с', castTimeSec: 'Каст, с', durationSec: 'Длительность, с', resource: 'Ресурс',
};
const label = (k: string): string => LABEL[k] ?? k;
/** Строки-различия + всегда-важные (стоимость/откат/урон), даже когда они не изменились. */
const ALWAYS = ['manaCost', 'cooldown', 'damageMult'];

function diffRows(base: unknown, after: unknown): { key: string; a: string; b: string; changed: boolean }[] {
  const A = flatten(base), B = flatten(after);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => k !== 'abilityId' && k !== 'category');
  const rows = keys.map((k) => ({ key: k, a: A[k] ?? '—', b: B[k] ?? '—', changed: A[k] !== B[k] }));
  return rows.filter((r) => r.changed || ALWAYS.includes(r.key))
    .sort((x, y) => (ALWAYS.indexOf(x.key) + 1 || 9) - (ALWAYS.indexOf(y.key) + 1 || 9) || x.key.localeCompare(y.key));
}

// ── Урон: считается ТЕМИ ЖЕ функциями, что и бой ─────────────────────────────
/**
 * Сборка синтетического героя с выбранным оружием. Уровень нужен ради атрибутов: урон оружия
 * масштабируется ими (`attackByType`), и без этого «Тесак на 30-м» показывал бы числа новичка.
 */
function heroWith(reg: ConfigRegistry, weapon: Item | undefined, level: number): SaveState {
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  save.level = Math.max(1, level);
  // Очки уровней раскидываем в ВЕДУЩИЙ атрибут класса (самый крупный на старте) — иначе герой
  // 30-го уровня стоял бы с единицами, и урон оружия вышел бы как у новичка.
  const start = reg.get('classes')[0]!.startAttributes;
  const main = (Object.keys(start) as (keyof typeof start)[])
    .reduce((a, b) => (start[b] > start[a] ? b : a));
  save.attributes[main] += (save.level - 1) * 3;
  save.equipment.weapon = weapon;
  return save;
}

/** Урон скилла по типам: базовый пакет оружия → форма скилла (`shapeSkillPacket`, как в движке). */
function skillDamage(
  reg: ConfigRegistry, save: SaveState, weapon: Item | undefined,
  active: NonNullable<ReturnType<typeof activeAbilityOf>>, carrierRank: number,
): { byType: Record<DamageType, { min: number; max: number }>; min: number; max: number; dps: number; rate: string } {
  const snap = playerSnapshot(save, reg);
  const bal = reg.get('balance');
  const base = attackByType(snap.derived, snap.attrs, weapon, bal.weaponAttrScaling, reg.get('weapon-weights'));
  const out = {} as Record<DamageType, { min: number; max: number }>;
  for (const t of DAMAGE_TYPES) out[t] = { min: base[t].min, max: base[t].max };
  let min = 0, max = 0, dps = 0, rate = '—';

  if (active.category === 'attack' || active.category === 'cast') {
    // ⚠ Стихию берём как движок: явная у способности, иначе — по имени (`abilityElementOf`).
    const el = active.element ?? abilityElementOf(active.abilityId);
    const shape = {
      mult: active.damageMult * abilityRankMult(carrierRank),
      multScope: active.multScope,
      addElementPct: active.addElementPct,
      convertPct: active.convertPct,
      baseType: (weapon?.damageType ?? 'physical') as DamageType,
      element: el as DamageType,
    };
    const lo = emptyPacket(), hi = emptyPacket();
    for (const t of DAMAGE_TYPES) { lo[t] = base[t].min; hi[t] = base[t].max; }
    shapeSkillPacket(lo, shape);
    shapeSkillPacket(hi, shape);
    for (const t of DAMAGE_TYPES) out[t] = { min: lo[t], max: hi[t] };
    const avg = (x: number, y: number): number => (x + y) / 2;
    for (const t of DAMAGE_TYPES) { min += out[t].min; max += out[t].max; }
    if (active.category === 'attack') {
      const r = Math.max(0.2, snap.derived.attackSpeed * active.speed);
      dps = avg(min, max) * r;
      rate = `${(1 / r).toFixed(2)} с/удар`;
    } else {
      const ct = active.castTimeSec / Math.max(0.2, snap.derived.castSpeed);
      dps = ct > 0 ? avg(min, max) / ct : avg(min, max);
      rate = `каст ${ct.toFixed(2)} с`;
    }
  }
  return { byType: out, min, max, dps, rate };
}

// ── Страница ─────────────────────────────────────────────────────────────────
export function renderSkillBuildPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.textContent = '';
  let reg: ConfigRegistry;
  try { reg = regFromData(data); }
  catch (e) { page.appendChild(h('div', 'color:#e88;padding:12px', `Конфиг не проходит валидацию: ${String(e)}`)); return; }

  // Достижимость считаем ДО раздачи доноров — после неё достижимо будет всё.
  const reachable = new Set(reg.get('skill-tree').nodes.map((n) => n.effect.grantsInsert).filter(Boolean) as string[]);
  ensureDonors(reg);

  const tree = reg.get('skill-tree');
  const actives = tree.nodes.filter((n) => n.effect.active);
  if (!actives.length) { page.appendChild(h('div', 'color:#9aa;padding:12px', 'В дереве нет активных скилов.')); return; }
  if (!actives.some((n) => n.id === nodeId)) { nodeId = actives[0]!.id; slots = []; }

  const branchName = (id: string): string => tree.branches.find((b) => b.id === id)?.name ?? id;
  const carrier = actives.find((n) => n.id === nodeId)!;
  const base = carrier.effect.active!;
  const open = socketsOpen(reg, rank);
  slots.length = open;
  for (let i = 0; i < open; i++) slots[i] ??= '';

  const wrap = h('div', 'display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px');
  wrap.appendChild(h('h2', 'margin:0;font-size:18px', '🧩 Сборка скила'));
  wrap.appendChild(h('div', 'color:#9aa;font-size:12px;max-width:760px',
    'Носитель + вставки → итог. Числа считает тот же resolveActive, что и сервер: показанное здесь и есть то, что получит игрок.'));

  // Выбор носителя, ранга и оружия.
  const bar = h('div', 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap');
  bar.appendChild(field('Скил-носитель', sel(nodeId,
    actives.map((n) => [n.id, `${branchName(n.branchId)} · ${n.name}`] as [string, string]),
    (v) => { nodeId = v; slots = []; renderSkillBuildPage(page, data); }, '320px')));
  const rankInp = document.createElement('input');
  rankInp.type = 'number'; rankInp.min = '1'; rankInp.max = '20'; rankInp.value = String(rank);
  rankInp.style.cssText = INP + ';width:70px';
  rankInp.addEventListener('change', () => { rank = Math.max(1, Math.min(20, Number(rankInp.value) || 1)); renderSkillBuildPage(page, data); });
  bar.appendChild(field('Ранг носителя', rankInp));
  // Ранг вставок отдельной ручкой: дизайнеру надо видеть и первый ранг, и десятый, не трогая носителя.
  const insInp = document.createElement('input');
  insInp.type = 'number'; insInp.min = '1'; insInp.max = '10'; insInp.value = String(insRank);
  insInp.style.cssText = INP + ';width:70px';
  insInp.addEventListener('change', () => { insRank = Math.max(1, Math.min(10, Number(insInp.value) || 1)); renderSkillBuildPage(page, data); });
  bar.appendChild(field('Ранг вставок', insInp));
  // ⭐ Оружие выбирается КОНКРЕТНОЕ, а не классом: по нему считается настоящий урон, а класс
  // для фильтра вставок берётся из самой вещи — одна ручка вместо двух рассогласованных.
  const weaponBases = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
  if (weaponBaseId && !weaponBases.some((b) => b.id === weaponBaseId)) weaponBaseId = '';
  bar.appendChild(field('Оружие в руках', sel(weaponBaseId,
    [['', '— без оружия —'], ...weaponBases.map((b) => [b.id, b.name] as [string, string])],
    (v) => { weaponBaseId = v; renderSkillBuildPage(page, data); }, '220px')));
  const tiersAll = [...reg.get('item-tiers')].sort((x, y) => x.minItemLevel - y.minItemLevel);
  bar.appendChild(field('Ступень оружия', sel(weaponTier,
    [['', '— по уровню —'], ...tiersAll.map((t) => [t.id, t.name] as [string, string])],
    (v) => { weaponTier = v; renderSkillBuildPage(page, data); })));
  const lvlInp = document.createElement('input');
  lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.max = '100'; lvlInp.value = String(charLevel);
  lvlInp.style.cssText = INP + ';width:70px';
  lvlInp.addEventListener('change', () => { charLevel = Math.max(1, Math.min(100, Number(lvlInp.value) || 1)); renderSkillBuildPage(page, data); });
  bar.appendChild(field('Уровень героя', lvlInp));

  // Само оружие: база + ступень. Редкость намеренно обычная — аффиксы случайны, и их разброс
  // превратил бы сравнение «до/после» в гадание вместо замера.
  const wBase = weaponBases.find((b) => b.id === weaponBaseId);
  let weapon: Item | undefined;
  if (wBase) {
    weapon = itemFromBase(wBase, reg.get('item-tiers'));
    const wt = tiersAll.find((t) => t.id === weaponTier);
    if (wt) weapon = retierItem(wBase, weapon, wt, { maxReqTotal: reg.get('balance').maxTotalRequirement });
  }
  const weaponClass = weapon?.weaponClass ?? '';
  bar.appendChild(h('div', 'color:#9aa;font-size:12px;padding-bottom:6px', `гнёзд открыто: ${open} (пороги ${reg.get('balance').skillSocketRanks.join('/')})`));
  wrap.appendChild(bar);

  // Гнёзда. В списке — только то, что влезает: чужая категория и чужое оружие сюда не попадают,
  // а тип, уже занятый другим гнездом, скрыт — правило «одна вставка типа» видно глазами.
  const typeName = (id: string): string => reg.get('skill-insert-types').find((t) => t.id === id)?.name ?? id;
  const usedTypes = new Set(slots.map((id) => (id ? insertById(reg, id)?.type : undefined)).filter(Boolean) as string[]);
  const socketRow = h('div', 'display:flex;gap:10px;flex-wrap:wrap');
  for (let i = 0; i < open; i++) {
    const cur = slots[i] ?? '';
    const curType = cur ? insertById(reg, cur)?.type : undefined;
    const opts: [string, string][] = [['', '— пусто —']];
    for (const ins of reg.get('skill-inserts')) {
      if (ins.enabled === false) continue;
      if (!insertFits(ins, base, weaponClass || undefined)) continue;
      if (ins.type !== curType && usedTypes.has(ins.type)) continue;
      opts.push([ins.id, `${reachable.has(ins.id) ? '' : '⚠ '}${typeName(ins.type)} · ${ins.name}`]);
    }
    socketRow.appendChild(field(`Гнездо ${i + 1}`, sel(cur, opts, (v) => { slots[i] = v; renderSkillBuildPage(page, data); }, '280px')));
  }
  wrap.appendChild(socketRow);

  const chosen = slots.filter(Boolean);
  const pv = previewBuild(reg, nodeId, rank, chosen, insRank);
  if (!pv) { page.appendChild(wrap); return; }

  // Недостижимые вставки — ошибка РАЗДАЧИ, а не сборки: показываем отдельно и явно.
  const dead = chosen.filter((id) => !reachable.has(id));
  if (dead.length) {
    wrap.appendChild(h('div', 'background:#3a2a1a;border:1px solid #6a4a2a;border-radius:6px;padding:8px 10px;color:#e8c08a;font-size:12px',
      `⚠ Открыть в игре нечем (нет узла-донора с grantsInsert): ${dead.join(', ')}. Игрок такую сборку собрать не сможет.`));
  }

  // Итог «до → после».
  const rows = diffRows(pv.base, pv.resolved.active);
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;font-size:13px;min-width:520px';
  const head = table.insertRow();
  for (const t of ['Поле', 'Голый скил', 'Со вставками']) {
    const th = document.createElement('th');
    th.textContent = t; th.style.cssText = 'text-align:left;padding:5px 10px;border-bottom:1px solid #2c2c3a;color:#9aa;font-weight:600';
    head.appendChild(th);
  }
  for (const r of rows) {
    const tr = table.insertRow();
    const cells = [label(r.key), r.a, r.b];
    cells.forEach((txt, i) => {
      const td = tr.insertCell();
      td.textContent = txt;
      td.style.cssText = `padding:4px 10px;border-bottom:1px solid #23232f;${i === 2 && r.changed ? 'color:#8fd08f;font-weight:600' : ''}${i === 0 ? 'color:#cfcfe0' : ''}`;
    });
  }
  wrap.appendChild(table);

  // ── УРОН: то, ради чего вставку и ставят ──────────────────────────────────
  // Таблица полей выше показывает `damageMult` и `addElementPct` — это ВХОДЫ. Дизайнеру нужен
  // выход: сколько урона выйдет из конкретного оружия. Считается теми же функциями, что и бой.
  {
    const hero = heroWith(reg, weapon, charLevel);
    const before = skillDamage(reg, hero, weapon, pv.base, rank);
    const after = skillDamage(reg, hero, weapon, pv.resolved.active, rank);
    const dmgBox = h('div', 'display:flex;flex-direction:column;gap:6px');
    dmgBox.appendChild(h('div', 'font-size:13px;color:#cfcfe0;font-weight:600', 'Урон'));
    if (!weapon) {
      dmgBox.appendChild(h('div', 'font-size:12px;color:#9aa', 'Выбери оружие — урон считается от него.'));
    } else if (pv.base.category !== 'attack' && pv.base.category !== 'cast') {
      dmgBox.appendChild(h('div', 'font-size:12px;color:#9aa', 'У этой способности прямого урона нет (аура/стойка/бафф/проклятие).'));
    } else {
      const t = document.createElement('table');
      t.style.cssText = 'border-collapse:collapse;font-size:13px;min-width:520px';
      const hd = t.insertRow();
      for (const c of ['', 'Голый скил', 'Со вставками', 'Разница']) {
        const th = document.createElement('th');
        th.textContent = c;
        th.style.cssText = 'text-align:left;padding:5px 10px;border-bottom:1px solid #2c2c3a;color:#9aa;font-weight:600';
        hd.appendChild(th);
      }
      const r2 = (x: number): string => String(Math.round(x));
      const row = (name: string, a: number, b: number, strong = false): void => {
        const tr = t.insertRow();
        const d = b - a;
        const cells = [name, r2(a), r2(b), d === 0 ? '—' : `${d > 0 ? '+' : ''}${r2(d)}`];
        cells.forEach((txt, i) => {
          const td = tr.insertCell();
          td.textContent = txt;
          const good = i === 3 && d > 0, bad = i === 3 && d < 0;
          td.style.cssText = `padding:4px 10px;border-bottom:1px solid #23232f;`
            + `${i === 0 ? 'color:#cfcfe0;' : ''}${strong ? 'font-weight:600;' : ''}`
            + `${good ? 'color:#8fd08f;font-weight:600' : bad ? 'color:#e88;font-weight:600' : ''}`;
        });
      };
      row('Урон, среднее', (before.min + before.max) / 2, (after.min + after.max) / 2, true);
      row('ДПС', before.dps, after.dps, true);
      for (const dt of DAMAGE_TYPES) {
        const a = (before.byType[dt].min + before.byType[dt].max) / 2;
        const b = (after.byType[dt].min + after.byType[dt].max) / 2;
        if (a < 0.5 && b < 0.5) continue;             // пустые стихии не засоряют таблицу
        row(`  ${dt}`, a, b);
      }
      dmgBox.appendChild(t);
      dmgBox.appendChild(h('div', 'font-size:11px;color:#9aa',
        `${weapon.name} · ${before.rate} · герой ${charLevel} ур. Редкость оружия обычная: аффиксы случайны,`
        + ' и их разброс превратил бы сравнение «до/после» в гадание вместо замера.'));
    }
    wrap.appendChild(dmgBox);
  }

  // Проки — отдельные способности, они не видны в таблице полей носителя.
  if (pv.resolved.procs.length) {
    const box = h('div', 'display:flex;flex-direction:column;gap:4px');
    box.appendChild(h('div', 'font-size:13px;color:#cfcfe0;font-weight:600', 'Доп. эффекты при использовании'));
    for (const p of pv.resolved.procs) {
      const a = p.ability as { category: string; damageMult?: number; radius?: number; element?: string; durationSec?: number };
      const bits = [`${insertById(reg, p.insertId)?.name ?? p.insertId}`, `${Math.round(p.chance * 100)}%`, a.category];
      if (a.element) bits.push(a.element);
      if (a.damageMult !== undefined) bits.push(`урон ×${a.damageMult}`);
      if (a.radius !== undefined) bits.push(`радиус ${a.radius}`);
      if (a.durationSec !== undefined) bits.push(`${a.durationSec} с`);
      box.appendChild(h('div', 'font-size:12px;color:#9aa;padding-left:8px', '• ' + bits.join(' · ')));
    }
    wrap.appendChild(box);
  }

  // Что реально применилось: тихо отброшенное (дубль типа, гнездо сверх ранга) видно сразу.
  const appliedIds = pv.resolved.applied.map((a) => a.insert.id);
  const dropped = chosen.filter((id) => !appliedIds.includes(id));
  wrap.appendChild(h('div', `font-size:12px;color:${dropped.length ? '#e8c08a' : '#9aa'}`,
    `Применилось ${appliedIds.length} из ${chosen.length}${dropped.length ? ` — отброшено: ${dropped.join(', ')}` : ''}`));

  page.appendChild(wrap);
}
