/**
 * ⭐ 16.10 (Артбук): МОНСТРЫ ПОДТИПА И ИХ ЖИВЫЕ ЧИСЛА для подвкладки «💀 Монстры» — тем же кодом, что игра. Без DOM → node-тесты.
 *
 *  • КТО В ПОДТИПЕ. `monsters[].subfaction === <подтип>`. Монстр без подтипа (поле пустое или в нём тема-культ из `subfactions`:
 *    `undead-fire`…) с фракцией нежити — Европа `medieval`: решение владельца 16.10, нынешние 19 зомби — Присяжные Короны, их
 *    переработают позже. Чужая фракция без подтипа — ни в одном.
 *  • КТО КАКОЙ АРХЕТИП. Имя монстра = имя архетипа в этом подтипе (`perSubtype[<подтип>].name`) — так заведённый позже «Посеянный»
 *    встанет к своему архетипу сам. Иначе привязка черновика: `existingMonsterId` + id В НАЧАЛЕ строк `existingAlso`
 *    («zombie-crossbow и zombie-bolter — арбалеты…»). Строка, которая начинается не с id («готового монстра нет; ближе всего по роли
 *    zombie-shaman»), — заметка, а не привязка. Монстр бывает у двух архетипов (двойник-вариант: дробитель — у рядового и у громилы).
 *  • ЧИСЛА. `generateMonster` с теми же входами, что заселение сервера (`spawnPacksEl`): деривация, гир, монстровые item-афиксы,
 *    редкости, `monster-rarity`, имена уников, `uniqueXpMult`; бросок — фиксированный сид (`createRng(seed)`), числа не прыгают от
 *    перерисовки. Бой — `monsterCombatStats` (то, что видит `resolveAttack`), статусы удара — `monsterDebuffs`.
 *  • УРОВЕНЬ ЭТАЖА — `floorChallengeLevel` заселения (`dungeon/floor.ts`); шов версий — у `floorMonsterLevel` ниже.
 */
import {
  createRng, floorChallengeLevel, generateMonster, monsterCombatStats, monsterDebuffs, PERCENT_STATS, STAT_LABEL,
  type ConfigRegistry, type ScaledMonster,
} from '@dm/shared';
import type { Archetype, CryptDraft } from './seed.js';

/** Подтип, к которому относятся монстры конфига без своего подтипа (решение владельца 16.10). */
export const LEGACY_SUBTYPE = 'medieval';

/** Минимум полей монстра конфига, по которым идёт привязка (годится и сырой `data.monsters`, и разобранный реестр). */
export interface MonsterLite { id: string; name: string; faction?: string; subfaction?: string; enabled?: boolean }

/** Подтип монстра конфига или `null` (не нежить крипты). */
export function subtypeOfMonster(m: MonsterLite, subIds: readonly string[]): string | null {
  if (m.subfaction && subIds.includes(m.subfaction)) return m.subfaction;
  return (m.faction ?? 'undead') === 'undead' && subIds.includes(LEGACY_SUBTYPE) ? LEGACY_SUBTYPE : null;
}

export function monstersOfSubtype<M extends MonsterLite>(monsters: readonly M[], subIds: readonly string[], subId: string): M[] {
  return monsters.filter((m) => subtypeOfMonster(m, subIds) === subId);
}

/**
 * id монстров в НАЧАЛЕ строки `existingAlso`: `<id>`, `<id> и <id>`, `<id>, <id>` — дальше пояснение. Только известные id:
 * опечатка в черновике не заводит призрачную строку.
 */
export function leadingIds(s: string, known: ReadonlySet<string>): string[] {
  const m = /^\s*([a-z0-9][a-z0-9_-]*)((?:\s*(?:,|\sи\s)\s*[a-z0-9][a-z0-9_-]*)*)/i.exec(s);
  if (!m) return [];
  const ids = [m[1]!, ...(m[2] ?? '').split(/\s*(?:,|\sи\s)\s*/)].map((x) => x.trim()).filter(Boolean);
  return ids.filter((id) => known.has(id));
}

export interface Binding {
  /** Архетип → монстры конфига (первый — основной, дальше варианты). */
  byArch: Map<string, string[]>;
  /** Монстры подтипа, которых не взял ни один архетип. */
  unbound: string[];
}

/** Архетипы подтипа в порядке черновика: общие, затем особые. */
export const archetypesOf = (draft: Pick<CryptDraft, 'archetypes'>, subId: string): Archetype[] =>
  draft.archetypes.filter((a) => a.subtypes.includes(subId));

const norm = (s: string): string => s.trim().toLowerCase().replace(/ё/g, 'е');

/** Привязка монстров подтипа к его архетипам (см. шапку). */
export function bindArchetypes(draft: Pick<CryptDraft, 'archetypes' | 'subtypes'>, subId: string, monsters: readonly MonsterLite[]): Binding {
  const subIds = draft.subtypes.map((s) => s.id);
  const mine = monstersOfSubtype(monsters, subIds, subId);
  const ids = new Set(mine.map((m) => m.id));
  const byArch = new Map<string, string[]>();
  const taken = new Set<string>();
  for (const a of archetypesOf(draft, subId)) {
    const list: string[] = [];
    const add = (id: string | undefined): void => { if (id && ids.has(id) && !list.includes(id)) list.push(id); };
    const nm = a.perSubtype[subId]?.name;
    if (nm) for (const m of mine) if (norm(m.name) === norm(nm)) add(m.id);
    add(a.existingMonsterId);
    for (const s of a.existingAlso ?? []) for (const id of leadingIds(s, ids)) add(id);
    for (const id of list) taken.add(id);
    byArch.set(a.id, list);
  }
  return { byArch, unbound: mine.filter((m) => !taken.has(m.id)).map((m) => m.id) };
}

/** Прообраз в конфиге для архетипа, у которого в подтипе монстра нет: монстр черновика (сейчас он чужого подтипа). */
export function protoOf(a: Archetype, monsters: readonly MonsterLite[]): MonsterLite | undefined {
  return a.existingMonsterId ? monsters.find((m) => m.id === a.existingMonsterId) : undefined;
}

// ── Уровень этажа и бросок монстра ───────────────────────────────────────────────────────────────

export type MonsterRarity = 'normal' | 'magic' | 'rare' | 'unique';
export const RARITIES: readonly MonsterRarity[] = ['normal', 'magic', 'rare', 'unique'];
export const RARITY_LABEL: Record<MonsterRarity, string> = { normal: 'обычный', magic: 'магический', rare: 'редкий', unique: 'уникальный' };

/**
 * ⚠ ШОВ ВЕРСИЙ (16.10). В рабочей копии лежит правка «Глубина и вейпоинты» (Г1, 13.10, ещё не в коммите): уровень монстров
 * этажа — ТОЛЬКО от глубины, `floorChallengeLevel(reg, сложность, этаж)`, и заселение кладёт в ноль-базовый `depth`
 * генератора `уровень − 1` (монстр этажа N — уровня N). До неё — `floorChallengeLevel(reg, мощь героя, сложность, этаж)`, а
 * заселение клало в `depth` сам уровень вызова (монстр выходил на уровень выше). Артбук понимает обе формы по числу
 * аргументов: так он считает ровно как сервер той копии, где лежит. Г1 в коммите — ветку «по мощи» удалить.
 */
export const LEVEL_BY_POWER = floorChallengeLevel.length >= 4;

/** Уровень монстров обычной комнаты этажа `floor` (1-based) на сложности — как у заселения сервера. До Г1 — для нового героя (мощь 1). */
export function floorMonsterLevel(reg: ConfigRegistry, difficultyId: string, floor: number): number {
  const f = Math.max(1, Math.floor(floor) || 1);
  const call = floorChallengeLevel as unknown as (...a: unknown[]) => number;
  return LEVEL_BY_POWER ? call(reg, 1, difficultyId, f) + 1 : call(reg, difficultyId, f);
}

type GenOpts = Parameters<typeof generateMonster>[3];

/**
 * ⚠ ШОВ ВЕРСИЙ: лестница ступеней снаряжения монстров (`monster-gear-tiers`) приходит той же незакоммиченной правкой («Монстры:
 * план по силе»); заселение передаёт её генератору. Нет ключа в конфиге — нет и ступеней (как у сервера этой копии).
 */
function optionalCfg(reg: ConfigRegistry, key: string): unknown {
  try { return (reg.get as (this: ConfigRegistry, k: string) => unknown).call(reg, key); } catch { return undefined; }
}

/** Входы `generateMonster` — РОВНО как у заселения этажа (`spawnPacksEl`), кроме `baseId`/`depth`/`rarity`. */
export function spawnInputs(reg: ConfigRegistry): { opts: Omit<GenOpts, 'depth'> } {
  const opts: Omit<GenOpts, 'depth'> = {
    uniqueXpMult: reg.get('balance').uniqueXpMult,
    mderive: reg.get('monster-derive'),
    itemAffixes: reg.get('monster-item-affixes'),
    rarities: reg.get('rarities'),
    monsterRarity: reg.get('monster-rarity'),
    monsterUniques: reg.get('monster-uniques'),
  };
  const gearTiers = optionalCfg(reg, 'monster-gear-tiers');
  if (gearTiers !== undefined) Object.assign(opts, { gearTiers });
  return { opts };
}

/** Сид броска артбука: числа магических/редких/уников не прыгают от перерисовки; «🎲» на странице листает его. */
export const ARTBOOK_SEED = 1;

/** Монстр конфига уровня `level` и редкости — генератором игры. `null` — монстра нет в конфиге. */
export function rollMonster(reg: ConfigRegistry, id: string, level: number, rarity: MonsterRarity, seed = ARTBOOK_SEED): ScaledMonster | null {
  const monsters = reg.get('monsters');
  if (!monsters.some((m) => m.id === id)) return null;
  const { opts } = spawnInputs(reg);
  return generateMonster(monsters, reg.get('monster-gear'), reg.get('monster-affixes'),
    { ...opts, baseId: id, depth: Math.max(1, Math.floor(level) || 1) - 1, rarity }, createRng(seed >>> 0 || 1));
}

// ── Числа строки и карточки ──────────────────────────────────────────────────────────────────────

export interface MonsterNumbers {
  id: string;
  /** Имя заготовки в конфиге. */
  name: string;
  /** Имя экземпляра: магический/редкий — со словами афиксов, уник — из пула имён. */
  shownName: string;
  level: number;
  rarity: MonsterRarity;
  hp: number; hpRegen: number;
  minDamage: number; maxDamage: number; damageType: string; physSub?: string;
  attackSpeed: number;
  armor: number; accuracy: number; evade: number; blockChance: number; critChance: number; critMultiplier: number;
  resFire: number; resCold: number; resLightning: number; resPoison: number;
  moveSpeed: number; xp: number; ai: string;
  /** Имена надетого по слотам (`gearRolls`, иначе по id заготовки). */
  weapon: string; armorName: string; helm: string; shield: string;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function numbersOf(m: ScaledMonster, baseName: string): MonsterNumbers {
  const cs = monsterCombatStats(m);
  const gear = (slot: string): string => m.gearRolls?.find((g) => g.slot === slot)?.name ?? '';
  return {
    id: m.id, name: baseName, shownName: m.name, level: m.level, rarity: m.rarity,
    hp: m.hp, hpRegen: m.hpRegen,
    minDamage: m.minDamage, maxDamage: m.maxDamage, damageType: m.damageType, ...(m.physSub ? { physSub: m.physSub } : {}),
    attackSpeed: r2(m.attackSpeed),
    armor: cs.armor, accuracy: cs.accuracy, evade: cs.evade, blockChance: cs.blockChance, critChance: cs.critChance, critMultiplier: cs.critMultiplier,
    resFire: cs.resFire, resCold: cs.resCold, resLightning: cs.resLightning, resPoison: cs.resPoison,
    moveSpeed: m.moveSpeed, xp: m.xp, ai: m.ai,
    weapon: gear('weapon'), armorName: gear('armor'), helm: gear('helm'), shield: gear('shield'),
  };
}

/** Числа монстра конфига на уровне. `null` — монстра нет. */
export function monsterNumbers(reg: ConfigRegistry, id: string, level: number, rarity: MonsterRarity, seed = ARTBOOK_SEED): MonsterNumbers | null {
  const m = rollMonster(reg, id, level, rarity, seed);
  if (!m) return null;
  return numbersOf(m, reg.get('monsters').find((x) => x.id === id)!.name);
}

export interface TableOpts { floor: number; difficulty: string; rarity: MonsterRarity; seed?: number }

/** Строка таблицы архетипов подтипа. */
export interface ArchRow {
  archId: string;
  /** Имя архетипа в подтипе (`perSubtype[<подтип>].name`) и общее имя («Рядовой»). */
  name: string;
  general: string;
  role: string;
  kind: 'common' | 'unique';
  /** Вторая и дальше строка архетипа — вариант (двойник с другим оружием). */
  variant: boolean;
  /** Монстр конфига строки; нет — «ещё нет в конфиге». */
  monsterId?: string;
  n?: MonsterNumbers;
  /** Монстр выключен в конфиге (`enabled: false`) — в игре не заселяется. */
  off?: true;
  /** Для пустой строки: прообраз в конфиге (монстр черновика; сейчас он другого подтипа). */
  proto?: { id: string; name: string };
}

export interface SubtypeTable {
  /** Уровень монстров обычной комнаты выбранного этажа. */
  level: number;
  rows: ArchRow[];
  /** Монстры подтипа без архетипа — со своими числами (их место решит переработка). */
  extra: { id: string; n: MonsterNumbers; off?: true }[];
}

/**
 * ЧИСТАЯ ФУНКЦИЯ ТАБЛИЦЫ ПОДТИПА: архетипы черновика × монстры конфига × числа игры на уровне этажа. Вход — реестр конфига
 * (`regFromData(data)`), черновик с правками владельца, подтип, этаж, сложность, редкость.
 */
export function subtypeTable(reg: ConfigRegistry, draft: Pick<CryptDraft, 'archetypes' | 'subtypes'>, subId: string, o: TableOpts): SubtypeTable {
  const level = floorMonsterLevel(reg, o.difficulty, o.floor);
  const monsters = reg.get('monsters');
  const off = (id: string): { off?: true } => (monsters.find((m) => m.id === id)?.enabled === false ? { off: true } : {});
  const { byArch, unbound } = bindArchetypes(draft, subId, monsters);
  const rows: ArchRow[] = [];
  for (const a of archetypesOf(draft, subId)) {
    const head = { archId: a.id, name: a.perSubtype[subId]?.name ?? a.name, general: a.name, role: a.role, kind: a.kind };
    const ids = byArch.get(a.id) ?? [];
    if (!ids.length) {
      const p = protoOf(a, monsters);
      rows.push({ ...head, variant: false, ...(p ? { proto: { id: p.id, name: p.name } } : {}) });
      continue;
    }
    ids.forEach((id, i) => {
      const n = monsterNumbers(reg, id, level, o.rarity, o.seed);
      rows.push({ ...head, variant: i > 0, monsterId: id, ...(n ? { n } : {}), ...off(id) });
    });
  }
  const extra = unbound.flatMap((id) => { const n = monsterNumbers(reg, id, level, o.rarity, o.seed); return n ? [{ id, n, ...off(id) }] : []; });
  return { level, rows, extra };
}

// ── Карточка монстра: атрибуты, гир, умения ──────────────────────────────────────────────────────

export const SLOT_LABEL_RU: Record<string, string> = { weapon: 'Оружие', armor: 'Доспех', helm: 'Шлем', shield: 'Щит' };
const CLASS_RU: Record<string, string> = {
  sword: 'меч', axe: 'топор', mace: 'булава', dagger: 'кинжал', spear: 'копьё', halberd: 'алебарда', bow: 'лук', crossbow: 'арбалет',
  wand: 'жезл', staff: 'посох', quilted: 'стёганка', leather: 'кожа', chain: 'кольчуга', segmented: 'сегментная', plate: 'латы',
  shield: 'щит',
};
export const AI_LABEL: Record<string, string> = { 'melee-chaser': 'ближний бой: догоняет', 'ranged-kiter': 'дальний бой: держит дистанцию', stationary: 'стоит на месте' };
const TIER_RU: Record<string, string> = { weak: 'слабый', medium: 'средний', strong: 'сильный', boss: 'босс' };

export interface GearPiece {
  slot: string; slotLabel: string;
  id: string; name: string;
  /** Класс вещи: оружия / брони / щита — по-русски, и как в конфиге. */
  cls: string; clsId: string;
  /** Числа вещи на этом уровне (база снаряжения; со ступенью, если она есть в этой копии). */
  damage?: string; damageType?: string; attackSpeed?: number; hands?: number; defense?: number; block?: number;
  /** Подтип физ. урона оружия по-русски («Режущий») — от него статус удара. */
  physSub?: string;
  modelId?: string;
  /** Ступень снаряжения по уровню (есть только с лестницей ступеней). */
  tier?: string;
  rarity: string;
  affixes: string[];
  /** Роллнутые модификаторы строками: «+15% Физ. урон». */
  mods: string[];
}

export interface MonsterSkill { name: string; text: string }

export interface MonsterCard {
  n: MonsterNumbers;
  enabled: boolean;
  role: string; roleName: string; roleDesc: string;
  tier: string; tierLabel: string;
  attrs: { str: number; dex: number; int: number; vit: number };
  gear: GearPiece[];
  skills: MonsterSkill[];
}

function fmtMod(m: { stat: string; kind: 'flat' | 'increased'; value: number }): string {
  const isPct = m.kind === 'increased' || PERCENT_STATS.has(m.stat);
  const v = isPct ? `${m.value >= 0 ? '+' : ''}${Math.round(m.value * 100)}%` : `${m.value >= 0 ? '+' : ''}${r2(m.value)}`;
  return `${v} ${STAT_LABEL[m.stat] ?? m.stat}`;
}

const pctS = (x: number): string => `${Math.round(x * 100)}%`;

/** Карточка монстра на уровне и редкости: числа, атрибуты заготовки, все вещи гира, умения. `null` — монстра нет. */
export function monsterCard(reg: ConfigRegistry, id: string, level: number, rarity: MonsterRarity, seed = ARTBOOK_SEED): MonsterCard | null {
  const m = rollMonster(reg, id, level, rarity, seed);
  if (!m) return null;
  const tpl = reg.get('monsters').find((x) => x.id === id)!;
  const gearCfg = reg.get('monster-gear');
  const roles = reg.get('monster-roles');
  const role = roles.find((r) => r.id === tpl.role);
  const physSubs = reg.get('phys-subtypes');
  const magic = reg.get('magic-subtypes');
  const debuffs = reg.get('debuffs');

  const gear: GearPiece[] = (m.gearRolls ?? []).map((g) => {
    const rec = gearCfg.find((x) => x.id === g.gearId);
    const clsId = !rec ? '' : rec.kind === 'weapon' ? rec.weaponClass : rec.kind === 'armor' ? rec.armorClass : 'shield';
    const p: GearPiece = {
      slot: g.slot, slotLabel: SLOT_LABEL_RU[g.slot] ?? g.slot, id: g.gearId ?? '', name: g.name,
      cls: CLASS_RU[clsId] ?? clsId, clsId, rarity: g.rarity, affixes: [...g.affixes], mods: g.mods.map(fmtMod),
    };
    const b = g.base;
    if (b.minDamage !== undefined) p.damage = `${b.minDamage}–${b.maxDamage ?? b.minDamage}`;
    if (b.damageType) p.damageType = b.damageType;
    if (b.attackSpeed !== undefined) p.attackSpeed = b.attackSpeed;
    if (b.defense) p.defense = b.defense;
    if (b.block !== undefined) p.block = b.block;
    if (rec?.kind === 'weapon') { p.hands = rec.hands; if (rec.physSub) p.physSub = physSubs.find((x) => x.id === rec.physSub)?.name ?? rec.physSub; }
    if (rec?.modelId) p.modelId = rec.modelId;
    const tier = (g as { tier?: string; tierName?: string });
    if (tier.tier) p.tier = tier.tierName ? `${tier.tierName} (${tier.tier})` : tier.tier;
    return p;
  });

  const skills: MonsterSkill[] = [];
  const beh = reg.get('monster-behaviors').find((b) => b.faction === tpl.faction);
  const atk = AI_LABEL[m.ai] ?? m.ai;
  skills.push({ name: 'Атака', text: m.ai === 'ranged-kiter' && beh ? `${atk} ${beh.keepDistMin}–${beh.keepDistMax}` : atk });
  if (role) skills.push({ name: `Роль: ${role.name}`, text: role.desc });
  for (const d of monsterDebuffs(m, physSubs, magic, debuffs)) {
    const name = debuffs.find((x) => x.id === d.kind)?.name ?? d.kind;
    skills.push({ name: `Удар: ${name}`, text: `шанс ${pctS(d.chance)}, до ${d.maxStacks} стак., ${r2(d.durationMs / 1000)} с` });
  }
  if (m.blockChance > 0) skills.push({ name: 'Блок щитом', text: `шанс ${pctS(m.blockChance)}` });
  if (beh) {
    if (beh.fleeHpPct > 0) skills.push({ name: 'Отход', text: `отступает при жизни ниже ${pctS(beh.fleeHpPct)}` });
    if (m.ai === 'ranged-kiter' && beh.repositionMode !== 'none') skills.push({ name: 'Смена позиции', text: beh.repositionMode === 'blink' ? 'телепорт' : 'смещается вбок' + (beh.repositionAfterShot ? ' после выстрела' : '') });
    if (beh.engageStyle === 'juggernaut') skills.push({ name: 'Натиск', text: 'медленный тяжёлый подход' });
    if (beh.signature === 'overload') skills.push({ name: 'Подпись', text: 'взрыв при смерти' });
    if (beh.hearingMode === 'investigate') skills.push({ name: 'Слух', text: 'на шум идёт проверить, бьёт, лишь увидев' });
    if (beh.packCohesion > 0) skills.push({ name: 'Стая', text: `тянется к центру группы (${beh.packCohesion})` });
  }
  if (m.hpRegen > 0) skills.push({ name: 'Регенерация', text: `${m.hpRegen} жизни/с` });

  return {
    n: numbersOf(m, tpl.name), enabled: tpl.enabled !== false,
    role: tpl.role, roleName: role?.name ?? tpl.role, roleDesc: role?.desc ?? '',
    tier: tpl.tier, tierLabel: TIER_RU[tpl.tier] ?? tpl.tier,
    attrs: { str: tpl.str, dex: tpl.dex, int: tpl.int, vit: tpl.vit },
    gear, skills,
  };
}
