/**
 * ⭐ 16.10 (Артбук): ЖИВЫЕ ЧИСЛА КЛАССА для страницы «🧙 Персонажи» — тем же кодом, что игра. Без DOM → node-тесты.
 *
 * Новый герой собирается `newCharacterSave` (единая истина создания персонажа у сервера и клиента: стартовые атрибуты,
 * оружие класса с заменой выключенной базы, кожаный комплект, требования «по руке» классу), статы — `playerSnapshot` (тот же
 * снимок, что у сессии: экипировка + класс брони + древа). Уровень N — тот же герой с `level = N` и НЕВЛОЖЕННЫМИ очками:
 * прибавка за уровень идёт сама (`hpPerLevel`…), а куда игрок вложит очки атрибутов — его выбор; число очков показываем рядом.
 */
import {
  ConfigRegistry, newCharacterSave, playerSnapshot, weaponSpeedOf, STAT_LABEL, SLOT_LABEL, PERCENT_STATS,
  type Attributes, type Item, type SaveState,
} from '@dm/shared';

export const ATTR_ORDER = ['strength', 'dexterity', 'intelligence', 'vitality'] as const;
export const FACTION_LABEL: Record<string, string> = { undead: 'нежить', demon: 'демоны', beast: 'звери', monster: 'монстры' };

/** Ресурсы и боевые числа героя на уровне. */
export interface ClassPools {
  level: number;
  hp: number; mana: number; stamina: number;
  hpRegen: number; manaRegen: number; staminaRegen: number;
  minDamage: number; maxDamage: number; attackSpeed: number;
  armor: number; accuracy: number; evade: number; blockChance: number; moveSpeed: number;
}

export interface KitItem {
  baseId: string;
  name: string;
  slot: string;
  /** Подпись слота по-русски. */
  slotLabel: string;
  kind: string;
  tier: string;
  equipped: boolean;
  /** «2–5» у оружия. */
  damage?: string;
  attackSpeed?: number;
  armor?: number;
  /** Требования строкой: «Сила 12, Ловкость 8». */
  req: string;
  /** Прочие базовые свойства строкой. */
  stats: string;
  modelId?: string;
}

export interface ClassNumbers {
  id: string;
  name: string;
  enabled: boolean;
  affinity: string[];
  startAttributes: Attributes;
  /** Ресурсы на 1-м и на выбранном уровне. */
  pools: ClassPools[];
  /** Очки, накопленные к выбранному уровню (их игрок раскладывает сам). */
  pointsAt: { level: number; attribute: number; skill: number; mastery: number };
  kit: KitItem[];
  /** id стартового оружия из конфига класса и то, что выдано (выключенную базу игра заменяет родственной). */
  startWeaponId: string;
  weaponIssued?: string;
}

/** Реестр из снимка конфига редактора — как у прочих страниц (`monsterGen.ts`, `calc.ts`): читатель рабочей копии. */
export function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data, { cross: false });
  return reg;
}

const round = (x: number, k = 1): number => Math.round(x * k) / k;

function poolsOf(reg: ConfigRegistry, save: SaveState): ClassPools {
  const { derived: d } = playerSnapshot(save, reg);
  return {
    level: save.level,
    hp: round(d.maxHp), mana: round(d.maxMana), stamina: round(d.maxStamina),
    hpRegen: round(d.hpRegen, 100), manaRegen: round(d.manaRegen, 100), staminaRegen: round(d.staminaRegen, 100),
    minDamage: round(d.minDamage), maxDamage: round(d.maxDamage), attackSpeed: round(d.attackSpeed, 100),
    armor: round(d.armor), accuracy: round(d.accuracy), evade: round(d.evade, 10), blockChance: round(d.blockChance, 1000),
    moveSpeed: round(d.moveSpeed),
  };
}

const sumFlat = (it: Item, stat: string): number => it.baseStats.filter((m) => m.stat === stat && m.kind === 'flat').reduce((s, m) => s + m.value, 0);

function fmtStat(stat: string, kind: string, value: number): string {
  const pct = kind === 'increased' || PERCENT_STATS.has(stat);
  const v = pct ? `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%` : `${value >= 0 ? '+' : ''}${round(value, 100)}`;
  return `${v} ${STAT_LABEL[stat] ?? stat}`;
}

export function kitItemOf(it: Item, equipped: boolean): KitItem {
  const minD = sumFlat(it, 'minDamage'), maxD = sumFlat(it, 'maxDamage'), armor = sumFlat(it, 'armor');
  const shown = new Set(['minDamage', 'maxDamage', 'armor', 'attackSpeed']);
  const rest = it.baseStats.filter((m) => !(shown.has(m.stat) && (m.kind === 'flat' || m.stat === 'attackSpeed')));
  const req = ATTR_ORDER.filter((a) => (it.requirements[a] ?? 0) > 0).map((a) => `${STAT_LABEL[a] ?? a} ${it.requirements[a]}`).join(', ');
  const k: KitItem = {
    baseId: it.baseId, name: it.name, slot: it.slot ?? '', slotLabel: SLOT_LABEL[it.slot ?? ''] ?? (it.slot ?? '—'),
    kind: it.kind ?? '', tier: it.tier ?? '', equipped, req: req || '—',
    stats: rest.map((m) => fmtStat(m.stat, m.kind, m.value)).join(', '),
  };
  if (minD || maxD) { k.damage = `${round(minD)}–${round(maxD)}`; k.attackSpeed = round(weaponSpeedOf(it), 100); }
  if (armor) k.armor = round(armor);
  if (it.modelId) k.modelId = it.modelId;
  return k;
}

/** Числа класса. `null` — класса нет в конфиге. Бросает, если конфиг не разбирается (страница показывает ошибку). */
export function classNumbers(reg: ConfigRegistry, classId: string, level: number): ClassNumbers | null {
  const cls = reg.get('classes').find((c) => c.id === classId);
  if (!cls) return null;
  const lvl = Math.max(1, Math.floor(level) || 1);
  const save = newCharacterSave(reg, cls.id, 'Артбук', 'artbook');
  const bal = reg.get('balance');
  const n = lvl - 1;
  const kit: KitItem[] = [
    ...Object.values(save.equipment).filter((x): x is Item => !!x).map((it) => kitItemOf(it, true)),
    ...save.inventory.map((it) => kitItemOf(it, false)),
  ];
  const out: ClassNumbers = {
    id: cls.id, name: cls.name, enabled: cls.enabled !== false,
    affinity: [...(cls.affinity ?? [])],
    startAttributes: { ...cls.startAttributes },
    pools: [poolsOf(reg, save), ...(lvl > 1 ? [poolsOf(reg, { ...save, level: lvl })] : [])],
    pointsAt: { level: lvl, attribute: bal.attributePointsPerLevel * n, skill: bal.skillPointsPerLevel * n, mastery: bal.masteryPointsPerLevel * n },
    kit,
    startWeaponId: cls.startWeaponId,
  };
  const w = save.equipment.weapon;
  if (w) out.weaponIssued = w.baseId;
  return out;
}
