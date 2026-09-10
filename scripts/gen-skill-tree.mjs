// Генератор ЕДИНОГО ДРЕВА СКИЛОВ (skill-tree): 25 веток с УНИКАЛЬНЫМ контентом (активки со способностью v3
// + пассивы со %-статом ветки). Связи по смежности. Гейт оружия и resource штампуются на способность.
// Значения черновые — тюнятся в редакторе. Пишет skill-tree.json. Запуск: node scripts/gen-skill-tree.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/shared/src/config/data/skill-tree.json');

// ── Билдеры способностей (минимальные; дефолты схемы дополнят) ──
const ail = (kind, chance, mag, durationMs, maxStacks = 4, mag2) =>
  (mag2 === undefined ? { kind, chance, mag, maxStacks, durationMs } : { kind, chance, mag, mag2, maxStacks, durationMs });
const atk = (id, name, cost, cd, o = {}) => ({ name, a: { category: 'attack', abilityId: id, manaCost: cost, cooldown: cd, ...o } });
const cst = (id, name, cost, cd, shape, o = {}) => ({ name, a: { category: 'cast', abilityId: id, manaCost: cost, cooldown: cd, shape, ...o } });
const crs = (id, name, cost, cd, o = {}) => ({ name, a: { category: 'curse', abilityId: id, manaCost: cost, cooldown: cd, ...o } });
const aur = (id, name, res, mods) => ({ name, a: { category: 'aura', abilityId: id, toggleGroup: 'aura', reservePct: res, buffMods: mods } });
const stn = (id, name, res, mods) => ({ name, a: { category: 'stance', abilityId: id, toggleGroup: 'stance', reservePct: res, buffMods: mods } });

// Гейт ветки хранит singular attackType/damageKind (как в branchSchema). Способности же
// используют weaponRestrict с ПЛЮРАЛЬНЫМИ массивами attackTypes/damageKinds — конвертируем.
const abilityGate = (gate) => {
  const g = { ...gate };
  if (g.attackType) { g.attackTypes = [g.attackType]; delete g.attackType; }
  if (g.damageKind) { g.damageKinds = [g.damageKind]; delete g.damageKind; }
  return g;
};

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/shared/src/config/data');
const INSERTS = JSON.parse(readFileSync(join(dataDir, 'skill-inserts.json'), 'utf8'));
const INS_TYPES = JSON.parse(readFileSync(join(dataDir, 'skill-insert-types.json'), 'utf8'));
const insById = new Map(INSERTS.map((i) => [i.id, i]));
const typeName = (id) => (INS_TYPES.find((t) => t.id === id) || {}).name || id;

// ── ОПИСАНИЯ. Раньше здесь стояло буквально `Активный скилл: <имя>` — отсюда и «половина скилов
// непонятно что делают». Текст собирается ИЗ ЧИСЕЛ способности: что не задано, то и не упоминается,
// поэтому описание не врёт и не устаревает при правке значений.
const AIL_RU = {
  wound: 'рану', bleed: 'кровотечение', sunder: 'увечье', daze: 'ошеломление',
  burn: 'поджиг', poison: 'отравление', shock: 'шок', freeze: 'обморожение',
};
const EL_RU = { physical: 'физическим', fire: 'огнём', cold: 'холодом', lightning: 'молнией', poison: 'ядом' };
const RES_RU = { stamina: 'выносливости', mana: 'маны' };
const SHAPE_RU = { nova: 'взрыв вокруг себя', ground: 'зона на земле', meteor: 'удар с неба',
  dash: 'рывок сквозь врагов', leap: 'прыжок', boomerang: 'снаряд' };
const pct = (x) => `${Math.round(x * 100)}%`;
/** Заглавная первая буква: фразы собираются из кусков, и начало предложения не должно быть строчным. */
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const num = (x) => String(Math.round(x * 100) / 100);

/** Кусок про накладываемый статус — общий для атак, кастов и проклятий. */
function ailPhrase(al) {
  if (!al || !al.kind) return null;
  const dur = al.durationMs ? ` на ${num(al.durationMs / 1000)} с` : '';
  const st = al.maxStacks > 1 ? `, до ${al.maxStacks} стаков` : '';
  return `${pct(al.chance)} наложить ${AIL_RU[al.kind] || al.kind}${dur}${st}`;
}

/** Описание способности из её полей. Порядок фраз — от главного к деталям. */
function describeAbility(a) {
  const out = [];
  if (a.category === 'attack') {
    const parts = [`Удар оружием ×${num(a.damageMult ?? 1)} к урону`];
    if (a.hits > 1) parts.push(`${a.hits} удара подряд`);
    if (a.count > 1) parts.push(`${a.count} снаряда веером`);
    if (a.speed && a.speed !== 1) parts.push(`скорость ×${num(a.speed)}`);
    if (a.arcMult && a.arcMult !== 1) parts.push(`дуга ×${num(a.arcMult)}`);
    if (a.rangeMult && a.rangeMult !== 1) parts.push(`дальность ×${num(a.rangeMult)}`);
    if (a.pierce) parts.push('пробивает насквозь');
    out.push(parts.join(', ') + '.');
  } else if (a.category === 'cast') {
    const parts = [`${SHAPE_RU[a.shape] || a.shape} ×${num(a.damageMult ?? 1)} к урону`];
    if (a.radius) parts.push(`радиус ${Math.round(a.radius)}`);
    if (a.dashDist) parts.push(`рывок на ${Math.round(a.dashDist)}`);
    out.push(cap(parts.join(', ')) + '.');
  } else if (a.category === 'curse') {
    out.push(`Проклятие по площади${a.radius ? `, радиус ${Math.round(a.radius)}` : ''}.`);
  } else if (a.category === 'aura' || a.category === 'stance') {
    out.push(`${a.category === 'aura' ? 'Аура' : 'Стойка'}: резервирует ${pct(a.reservePct ?? 0)} пула.`);
  } else if (a.category === 'buff') {
    out.push(`Усиление на ${num(a.durationSec ?? 0)} с.`);
  }
  // Состав урона: стихия появляется только там, где реально меняет пакет.
  if (a.element && a.element !== 'physical') {
    if (a.convertPct) out.push(`${pct(a.convertPct)} урона переводится в урон ${EL_RU[a.element] || a.element}.`);
    else if (a.addElementPct) out.push(`Сверху ${pct(a.addElementPct)} урона ${EL_RU[a.element] || a.element}.`);
    else out.push(`Бьёт ${EL_RU[a.element] || a.element}.`);
  }
  const ail = ailPhrase(a.ailment);
  if (ail) out.push(cap(ail) + '.');
  const ctl = [];
  if (a.knockback) ctl.push(`отбрасывает на ${Math.round(a.knockback)}`);
  if (a.stunSec) ctl.push(`оглушает на ${num(a.stunSec)} с`);
  if (a.knockdownChance) ctl.push(`${pct(a.knockdownChance)} сбить с ног`);
  if (ctl.length) out.push(cap(ctl.join(', ')) + '.');
  // Модификаторы аур/стоек/баффов — иначе про них не сказано вообще ничего.
  for (const m of a.buffMods || []) {
    const sign = m.value >= 0 ? '+' : '−';
    out.push(`${sign}${pct(Math.abs(m.value))} ${SL[m.stat] || m.stat}.`);
  }
  const cost = [];
  if (a.manaCost) cost.push(`${num(a.manaCost)} ${RES_RU[a.resource] || a.resource || ''}`.trim());
  if (a.cooldown) cost.push(`откат ${num(a.cooldown)} с`);
  if (a.castTimeSec) cost.push(`каст ${num(a.castTimeSec)} с`);
  if (cost.length) out.push(`Цена: ${cost.join(', ')}.`);
  return out.join(' ');
}

/**
 * Описание пассива из его модификаторов. Классовые узлы приезжают из легаси-файла, где описания
 * либо пустые, либо бессодержательные, — собираем сами по тем же правилам, что и для веток.
 */
function describePassive(mods, fallback) {
  const parts = (mods || []).map((m) => {
    const sign = m.value >= 0 ? '+' : '−';
    return `${sign}${pct(Math.abs(m.value))} ${SL[m.stat] || m.stat}`;
  });
  if (!parts.length) return fallback || '';
  return `${parts.join(', ')} за ранг.`;
}

/** Описание узла-вставки: что открывает, что вставка делает и чем за это платят. */
function describeInsertNode(ins) {
  const cost = [];
  if (ins.costMult !== 1) cost.push(`стоимость ×${num(ins.costMult)}`);
  if (ins.cooldownMult !== 1) cost.push(`откат ×${num(ins.cooldownMult)}`);
  // Про конверсию говорим ОТДЕЛЬНО: она гасит физический статус оружия (packet.physical → 0),
  // и без этой строчки игрок считает пропавшее кровотечение багом.
  const conv = ins.tune && ins.tune.convertPct >= 1
    ? ' Полная конверсия убирает физические статусы оружия (кровотечение, увечье и прочие).' : '';
  return `Открывает вставку «${ins.name}» (${typeName(ins.type)}). ${ins.description}` +
    (cost.length ? ` Носитель платит: ${cost.join(', ')}.` : '') + conv +
    ' Ранг узла усиливает вставку.';
}

// Подпись стата для описания пассива (fallback, если не задана явно).
const SL = {
  critChance: 'к шансу крита', critMultiplier: 'к множителю крита', ailmentPct: 'к наложению статусов',
  attackSpeed: 'к скорости атаки', castSpeed: 'к скорости каста', armorPen: 'к пробою брони цели',
  physPct: 'к физ. урону', damagePct: 'ко всему урону', firePct: 'к урону огнём', coldPct: 'к урону холодом',
  lightningPct: 'к урону молнией', poisonPct: 'к урону ядом', moveSpeed: 'к скорости движения',
  accuracy: 'к меткости', evade: 'к уклонению', armor: 'к броне', blockChance: 'к блоку',
  interruptResist: 'к стойкости к прерыванию', maxHp: 'к здоровью', maxMana: 'к мане', maxStamina: 'к выносливости',
  hpRegen: 'к регену HP', manaRegen: 'к регену маны', staminaRegen: 'к регену выносливости',
  resFire: 'к сопр. огню', resCold: 'к сопр. холоду', resLightning: 'к сопр. молнии', resPoison: 'к сопр. яду',
};
// Пассив: [stat, kind, value, name] — statLabel берётся из SL.
const p = (stat, kind, value, name) => [stat, kind, value, name];

// ── Контент по веткам (act: 5 способностей, pas: 10 пассивов) ──
const C = {
  // === Ближнее 1-руч (выносливость) ===
  dagger: { act: [
    atk('dagger-thrust', 'Быстрый выпад', 4, 0, { speed: 1.7, damageMult: 1.1 }),
    atk('dagger-wound', 'Ранящий удар', 7, 0.8, { damageMult: 1.5, ailment: ail('wound', 0.8, 0.09, 4000, 5, 0.1) }),
    atk('dagger-flurry', 'Серия уколов', 8, 1.0, { speed: 1.4, damageMult: 0.4, hits: 3 }),
    atk('dagger-venom', 'Отравленный клинок', 5, 0, { element: 'poison', damageMult: 1.1, ailment: ail('poison', 0.7, 4, 4000, 6) }),
    atk('dagger-lunge', 'Пронзающий выпад', 9, 1.2, { arcMult: 0.4, rangeMult: 1.6, pierce: true, damageMult: 1.4 }),
  ], pas: [p('critChance', 'increased', 0.05, 'Отточенность'), p('critMultiplier', 'flat', 0.06, 'Смертельная точность'), p('ailmentPct', 'flat', 0.06, 'Глубокая рана'), p('attackSpeed', 'increased', 0.04, 'Молниеносность'), p('armorPen', 'flat', 0.05, 'Пробой брони'), p('physPct', 'flat', 0.05, 'Мастерство клинка'), p('moveSpeed', 'increased', 0.03, 'Проворство'), p('evade', 'increased', 0.04, 'Скользящий шаг'), p('staminaRegen', 'increased', 0.06, 'Второе дыхание'), p('maxStamina', 'increased', 0.05, 'Закалка')] },
  sword1h: { act: [
    atk('sword-slash', 'Рубящий удар', 5, 0, { damageMult: 1.3, ailment: ail('bleed', 0.4, 4, 3000, 5) }),
    atk('sword-riposte', 'Парирующий выпад', 6, 1.0, { damageMult: 1.4, arcMult: 0.8, ailment: ail('bleed', 0.5, 5, 3000, 5) }),
    atk('sword-cleave', 'Размашистый удар', 8, 1.2, { damageMult: 1.2, arcMult: 1.6 }),
    atk('sword-thrust', 'Пронзающий меч', 7, 0.8, { damageMult: 1.5, pierce: true }),
    atk('sword-flurry', 'Клинковый шквал', 9, 1.2, { speed: 1.3, damageMult: 0.6, hits: 2 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Заточка'), p('attackSpeed', 'increased', 0.04, 'Фехтование'), p('critChance', 'increased', 0.05, 'Верный глаз'), p('critMultiplier', 'flat', 0.06, 'Смертельный росчерк'), p('ailmentPct', 'flat', 0.05, 'Глубокий порез'), p('damagePct', 'flat', 0.04, 'Сила удара'), p('accuracy', 'increased', 0.05, 'Точность'), p('evade', 'increased', 0.04, 'Парирование'), p('maxStamina', 'increased', 0.05, 'Закалка'), p('staminaRegen', 'increased', 0.06, 'Дыхание боя')] },
  axe1h: { act: [
    atk('axe-chop', 'Рубка', 6, 0, { damageMult: 1.4, ailment: ail('sunder', 0.5, 0.05, 4000, 5) }),
    atk('axe-rend', 'Раскол доспеха', 8, 1.2, { damageMult: 1.3, ailment: ail('sunder', 0.7, 0.07, 4000, 5) }),
    atk('axe-cleave', 'Секира', 9, 1.2, { damageMult: 1.3, arcMult: 1.7 }),
    atk('axe-bleed', 'Кровавый разруб', 7, 0.9, { damageMult: 1.4, ailment: ail('bleed', 0.6, 6, 3000, 5) }),
    atk('axe-rage', 'Неистовый удар', 12, 2.5, { damageMult: 2.0 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Мощь'), p('critMultiplier', 'flat', 0.07, 'Жестокость'), p('armorPen', 'flat', 0.06, 'Раскол'), p('ailmentPct', 'flat', 0.05, 'Глубокая рана'), p('attackSpeed', 'increased', 0.03, 'Замах'), p('damagePct', 'flat', 0.04, 'Ярость'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Второе дыхание'), p('maxHp', 'increased', 0.03, 'Крепость'), p('critChance', 'increased', 0.04, 'Точный разруб')] },
  mace1h: { act: [
    atk('mace-smash', 'Сокрушающий удар', 6, 0, { damageMult: 1.4, ailment: ail('daze', 0.5, 0.08, 2500, 4) }),
    atk('mace-stun', 'Оглушающий удар', 8, 1.5, { damageMult: 1.2, stunSec: 0.6, ailment: ail('daze', 0.7, 0.1, 3000, 4) }),
    atk('mace-crush', 'Дробление брони', 8, 1.2, { damageMult: 1.3, ailment: ail('sunder', 0.7, 0.07, 4000, 5) }),
    atk('mace-sweep', 'Круговой замах', 9, 1.3, { damageMult: 1.2, arcMult: 1.6, knockback: 120 }),
    atk('mace-quake', 'Богатырский удар', 12, 2.5, { damageMult: 1.8, stunSec: 0.4, knockback: 150 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Сила'), p('damagePct', 'flat', 0.04, 'Мощь удара'), p('armorPen', 'flat', 0.06, 'Дробление'), p('ailmentPct', 'flat', 0.05, 'Оглушение'), p('interruptResist', 'flat', 0.04, 'Стойкость'), p('maxHp', 'increased', 0.04, 'Крепость'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Второе дыхание'), p('attackSpeed', 'increased', 0.03, 'Размах'), p('critMultiplier', 'flat', 0.06, 'Сокрушение')] },
  // === Ближнее 2-руч (выносливость) ===
  sword2h: { act: [
    atk('gs-cleave', 'Широкий взмах', 7, 1.0, { damageMult: 1.4, arcMult: 2.0, ailment: ail('bleed', 0.5, 6, 3000, 5) }),
    atk('gs-spin', 'Крутящийся клинок', 12, 2.2, { damageMult: 1.2, arcMult: 2.8 }),
    atk('gs-thrust', 'Мощный выпад', 8, 1.0, { damageMult: 1.7, pierce: true, rangeMult: 1.3 }),
    atk('gs-execute', 'Обезглавливание', 14, 3, { damageMult: 2.3, ailment: ail('bleed', 0.7, 8, 4000, 5) }),
    atk('gs-slam', 'Рассекающий удар', 9, 1.4, { damageMult: 1.5, arcMult: 1.4, knockback: 100 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Хват'), p('damagePct', 'flat', 0.05, 'Сила размаха'), p('critMultiplier', 'flat', 0.07, 'Смертельный удар'), p('armorPen', 'flat', 0.05, 'Рассечение'), p('ailmentPct', 'flat', 0.05, 'Кровопускание'), p('maxHp', 'increased', 0.04, 'Мощь тела'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('critChance', 'increased', 0.04, 'Точный взмах'), p('attackSpeed', 'increased', 0.03, 'Замах')] },
  axe2h: { act: [
    atk('ba-cleave', 'Тяжёлая рубка', 7, 1.0, { damageMult: 1.5, arcMult: 1.8, ailment: ail('sunder', 0.6, 0.07, 4000, 5) }),
    atk('ba-rend', 'Разлом', 9, 1.4, { damageMult: 1.4, ailment: ail('sunder', 0.8, 0.1, 4000, 5) }),
    atk('ba-whirl', 'Вихрь секир', 13, 2.4, { damageMult: 1.2, arcMult: 2.8 }),
    atk('ba-bleed', 'Мясницкий удар', 8, 1.1, { damageMult: 1.5, ailment: ail('bleed', 0.7, 8, 3000, 5) }),
    atk('ba-berserk', 'Казнящий удар', 14, 3, { damageMult: 2.4 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Мощь'), p('damagePct', 'flat', 0.05, 'Ярость'), p('critMultiplier', 'flat', 0.07, 'Жестокость'), p('armorPen', 'flat', 0.06, 'Раскол'), p('ailmentPct', 'flat', 0.05, 'Глубокая рана'), p('maxHp', 'increased', 0.04, 'Крепость'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Второе дыхание'), p('critChance', 'increased', 0.04, 'Точный разруб'), p('attackSpeed', 'increased', 0.03, 'Замах')] },
  mace2h: { act: [
    atk('wh-smash', 'Сокрушение', 7, 1.0, { damageMult: 1.5, ailment: ail('daze', 0.6, 0.1, 3000, 4) }),
    atk('wh-quake', 'Землетрясение', 13, 3, { damageMult: 1.6, arcMult: 2.6, stunSec: 0.5, knockback: 150 }),
    atk('wh-stun', 'Оглушающий молот', 9, 1.6, { damageMult: 1.4, stunSec: 0.8, ailment: ail('daze', 0.8, 0.12, 3000, 4) }),
    atk('wh-crush', 'Дробитель', 8, 1.2, { damageMult: 1.4, ailment: ail('sunder', 0.8, 0.1, 4000, 5) }),
    atk('wh-slam', 'Богатырский обвал', 14, 3, { damageMult: 2.2, stunSec: 0.5, knockback: 180 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Сила'), p('damagePct', 'flat', 0.05, 'Мощь'), p('armorPen', 'flat', 0.06, 'Дробление'), p('ailmentPct', 'flat', 0.05, 'Оглушение'), p('interruptResist', 'flat', 0.05, 'Стойкость'), p('maxHp', 'increased', 0.04, 'Крепость'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('critMultiplier', 'flat', 0.06, 'Сокрушение'), p('attackSpeed', 'increased', 0.03, 'Замах')] },
  spear: { act: [
    atk('spear-thrust', 'Длинный выпад', 5, 0, { damageMult: 1.3, pierce: true, rangeMult: 1.5, arcMult: 0.5, ailment: ail('wound', 0.5, 0.06, 3500, 5, 0.08) }),
    atk('spear-impale', 'Пронзание', 8, 1.2, { damageMult: 1.7, pierce: true, rangeMult: 1.4, ailment: ail('wound', 0.7, 0.09, 4000, 5, 0.1) }),
    atk('spear-sweep', 'Подсечка', 9, 1.3, { damageMult: 1.1, arcMult: 1.8, knockback: 100 }),
    cst('spear-charge', 'Копейный натиск', 8, 5, 'dash', { damageMult: 1.0, dashDist: 220 }),
    atk('spear-phalanx', 'Строй копий', 12, 2.5, { damageMult: 1.4, rangeMult: 1.6, pierce: true }),
  ], pas: [p('physPct', 'flat', 0.05, 'Хватка'), p('accuracy', 'increased', 0.05, 'Меткость'), p('critChance', 'increased', 0.05, 'Точный укол'), p('armorPen', 'flat', 0.05, 'Пробой'), p('ailmentPct', 'flat', 0.05, 'Глубокая рана'), p('attackSpeed', 'increased', 0.03, 'Проворство'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('evade', 'increased', 0.04, 'Дистанция'), p('damagePct', 'flat', 0.04, 'Сила укола')] },
  halberd: { act: [
    atk('halberd-sweep', 'Широкий взмах', 7, 1.0, { damageMult: 1.3, arcMult: 2.0, rangeMult: 1.3, ailment: ail('sunder', 0.6, 0.07, 4000, 5) }),
    atk('halberd-hook', 'Зацеп', 8, 1.4, { damageMult: 1.2, knockback: 140, ailment: ail('wound', 0.6, 0.08, 3500, 5) }),
    atk('halberd-cleave', 'Рубящий размах', 9, 1.3, { damageMult: 1.4, arcMult: 1.8 }),
    atk('halberd-thrust', 'Пробивающий выпад', 8, 1.0, { damageMult: 1.6, pierce: true, rangeMult: 1.4 }),
    atk('halberd-spin', 'Смертельная карусель', 13, 2.5, { damageMult: 1.3, arcMult: 2.8, rangeMult: 1.2 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Хват'), p('damagePct', 'flat', 0.04, 'Размах'), p('armorPen', 'flat', 0.05, 'Пробой'), p('ailmentPct', 'flat', 0.05, 'Глубокая рана'), p('critChance', 'increased', 0.04, 'Точность'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('maxHp', 'increased', 0.03, 'Крепость'), p('critMultiplier', 'flat', 0.06, 'Смертельный размах'), p('attackSpeed', 'increased', 0.03, 'Замах')] },
  // === Дальнобой (выносливость) ===
  bow: { act: [
    atk('bow-aimed', 'Прицельный выстрел', 5, 0, { damageMult: 1.5, pierce: true }),
    atk('bow-multi', 'Тройной выстрел', 8, 0.8, { damageMult: 0.7, count: 3, spread: 0.3 }),
    cst('bow-rain', 'Ливень стрел', 14, 6, 'ground', { damageMult: 1.4, radius: 150 }),
    atk('bow-pin', 'Пришпиливающий выстрел', 7, 1.2, { damageMult: 1.3, pierce: true, ailment: ail('wound', 0.6, 0.08, 3500, 5) }),
    atk('bow-volley', 'Веер стрел', 10, 1.2, { damageMult: 0.5, count: 5, spread: 0.5 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Натяжение'), p('attackSpeed', 'increased', 0.04, 'Скорострельность'), p('accuracy', 'increased', 0.06, 'Соколиный глаз'), p('critChance', 'increased', 0.05, 'Меткий выстрел'), p('critMultiplier', 'flat', 0.07, 'В яблочко'), p('damagePct', 'flat', 0.04, 'Сила выстрела'), p('moveSpeed', 'increased', 0.03, 'Лёгкая поступь'), p('evade', 'increased', 0.04, 'Уклонение'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание')] },
  crossbow: { act: [
    atk('xbow-heavy', 'Тяжёлый болт', 6, 0.9, { damageMult: 1.8, pierce: true }),
    atk('xbow-snipe', 'Снайперский выстрел', 9, 2, { damageMult: 2.4, pierce: true }),
    cst('xbow-explosive', 'Разрывной болт', 14, 5, 'meteor', { element: 'fire', convertPct: 0.5, damageMult: 1.6, radius: 130, ailment: ail('burn', 0.6, 6, 3000, 5) }),
    atk('xbow-pierce', 'Бронебойный болт', 8, 1.2, { damageMult: 1.5, pierce: true }),
    atk('xbow-barrage', 'Залп болтов', 11, 1.4, { damageMult: 0.6, count: 4, spread: 0.35 }),
  ], pas: [p('physPct', 'flat', 0.05, 'Механизм'), p('critChance', 'increased', 0.05, 'Прицел'), p('critMultiplier', 'flat', 0.08, 'Смертельный болт'), p('accuracy', 'increased', 0.05, 'Меткость'), p('armorPen', 'flat', 0.06, 'Бронебойность'), p('damagePct', 'flat', 0.04, 'Убойная сила'), p('attackSpeed', 'increased', 0.03, 'Перезарядка'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('maxHp', 'increased', 0.03, 'Стойкость')] },
  // === Дуал (выносливость) ===
  dual: { act: [
    atk('dual-flurry', 'Шквал клинков', 6, 0, { speed: 1.5, damageMult: 0.7, hits: 2 }),
    atk('dual-cross', 'Перекрёстный удар', 7, 0.8, { damageMult: 1.4, ailment: ail('bleed', 0.5, 5, 3000, 5) }),
    atk('dual-whirl', 'Вихрь клинков', 12, 2.2, { damageMult: 1.0, arcMult: 2.6 }),
    atk('dual-dance', 'Танец клинков', 9, 1.2, { speed: 1.3, damageMult: 0.5, hits: 3 }),
    atk('dual-rend', 'Двойной разрез', 8, 1.0, { damageMult: 1.5, ailment: ail('bleed', 0.6, 6, 3000, 5) }),
  ], pas: [p('physPct', 'flat', 0.05, 'Двоерукость'), p('attackSpeed', 'increased', 0.05, 'Скорость'), p('critChance', 'increased', 0.05, 'Точность'), p('critMultiplier', 'flat', 0.06, 'Смертельный танец'), p('ailmentPct', 'flat', 0.05, 'Глубокий порез'), p('damagePct', 'flat', 0.04, 'Ярость'), p('evade', 'increased', 0.04, 'Уклонение'), p('moveSpeed', 'increased', 0.03, 'Проворство'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Дыхание')] },
  // === Магич. оружие (мана) ===
  wand: { act: [
    atk('wand-bolt', 'Магический заряд', 4, 0, { damageMult: 1.2 }),
    cst('wand-missiles', 'Волшебные снаряды', 9, 1.0, 'boomerang', { damageMult: 1.2, convertPct: 0.4 }),
    cst('wand-nova', 'Разряд силы', 10, 1.6, 'nova', { damageMult: 1.4, radius: 140, convertPct: 0.4 }),
    cst('wand-blink', 'Мерцание', 8, 5, 'dash', { damageMult: 0.5, dashDist: 200 }),
    cst('wand-barrage', 'Шквал зарядов', 14, 4, 'ground', { damageMult: 1.4, radius: 150, convertPct: 0.4 }),
  ], pas: [p('damagePct', 'flat', 0.05, 'Волшебство'), p('castSpeed', 'increased', 0.05, 'Быстрый каст'), p('maxMana', 'increased', 0.05, 'Резерв маны'), p('manaRegen', 'increased', 0.06, 'Поток маны'), p('critChance', 'increased', 0.05, 'Магический крит'), p('ailmentPct', 'flat', 0.05, 'Наведение'), p('critMultiplier', 'flat', 0.06, 'Всплеск'), p('maxMana', 'increased', 0.04, 'Глубина маны'), p('castSpeed', 'increased', 0.03, 'Ловкость рук'), p('damagePct', 'flat', 0.04, 'Мощь заряда')] },
  staff: { act: [
    atk('staff-blast', 'Удар силы', 5, 0, { damageMult: 1.3 }),
    cst('staff-nova', 'Волна силы', 12, 1.8, 'nova', { damageMult: 1.6, radius: 160, convertPct: 0.5 }),
    cst('staff-beam', 'Луч', 10, 1.4, 'boomerang', { damageMult: 1.4, convertPct: 0.5 }),
    cst('staff-storm', 'Буря силы', 18, 6, 'ground', { damageMult: 1.7, radius: 170, convertPct: 0.5 }),
    cst('staff-meteor', 'Кара небес', 20, 6, 'meteor', { damageMult: 2.2, radius: 150, convertPct: 0.5 }),
  ], pas: [p('damagePct', 'flat', 0.05, 'Мудрость'), p('castSpeed', 'increased', 0.05, 'Концентрация'), p('maxMana', 'increased', 0.05, 'Резервуар'), p('manaRegen', 'increased', 0.06, 'Медитация'), p('critChance', 'increased', 0.05, 'Прозрение'), p('ailmentPct', 'flat', 0.05, 'Проникновение'), p('critMultiplier', 'flat', 0.06, 'Всплеск силы'), p('maxMana', 'increased', 0.04, 'Глубина'), p('castSpeed', 'increased', 0.03, 'Плавность'), p('damagePct', 'flat', 0.04, 'Мощь')] },
  // === Стихии (мана, magic-оружие) ===
  fire: { act: elementCasts('fire', 'fire', 'burn', 6, 3000, ['Огненный шар', 'Взрыв пламени', 'Стена огня', 'Метеор', 'Огненный рывок']),
    pas: elemPas('firePct', ['Жар', 'Пекло', 'Испепеление', 'Поджог']) },
  cold: { act: elementCasts('cold', 'cold', 'freeze', 0.18, 2500, ['Ледяная стрела', 'Ледяная нова', 'Мороз', 'Град', 'Ледяной рывок']),
    pas: elemPas('coldPct', ['Стужа', 'Мороз', 'Оледенение', 'Обморожение']) },
  lightning: { act: elementCasts('lightning', 'lightning', 'shock', 0.1, 3000, ['Молния', 'Разряд', 'Гроза', 'Небесная кара', 'Молниеносный рывок']),
    pas: elemPas('lightningPct', ['Заряд', 'Электризация', 'Перегрузка', 'Разряд']) },
  poison: { act: elementCasts('poison', 'poison', 'poison', 5, 4000, ['Ядовитый дротик', 'Облако яда', 'Чумное поле', 'Кара гнили', 'Ядовитый рывок']),
    pas: elemPas('poisonPct', ['Токсин', 'Зараза', 'Чума', 'Разъедание']) },
  // === Проклятья (мана) ===
  curse: { act: [
    crs('curse-weakness', 'Слабость', 8, 8, { radius: 200, ailment: ail('wound', 0.8, 0.08, 4000, 5, 0.1) }),
    crs('curse-sunder', 'Порча брони', 10, 8, { radius: 200, ailment: ail('sunder', 0.8, 0.07, 4000, 5) }),
    crs('curse-freeze', 'Оцепенение', 10, 8, { radius: 190, ailment: ail('freeze', 0.8, 0.2, 3000, 5, 0.2) }),
    crs('curse-decay', 'Разложение', 12, 9, { radius: 200, element: 'poison', ailment: ail('poison', 0.9, 6, 5000, 8) }),
    crs('curse-doom', 'Погибель', 16, 12, { radius: 250, ailment: ail('daze', 0.7, 0.1, 4000, 5) }),
  ], pas: [p('ailmentPct', 'flat', 0.07, 'Могущество проклятий'), p('castSpeed', 'increased', 0.05, 'Скорость наложения'), p('maxMana', 'increased', 0.05, 'Резерв маны'), p('damagePct', 'flat', 0.04, 'Тёмная мощь'), p('manaRegen', 'increased', 0.06, 'Поток тьмы'), p('ailmentPct', 'flat', 0.06, 'Гнёт'), p('critChance', 'increased', 0.04, 'Злой рок'), p('maxMana', 'increased', 0.04, 'Глубина тьмы'), p('castSpeed', 'increased', 0.03, 'Ворожба'), p('critMultiplier', 'flat', 0.06, 'Проклятая сила')] },
  // === Ауры (резерв маны) ===
  aura: { act: [
    aur('aura-wrath', 'Аура гнева', 0.25, [{ stat: 'damagePct', kind: 'flat', value: 0.12 }]),
    aur('aura-elements', 'Стихийная аура', 0.3, [{ stat: 'firePct', kind: 'flat', value: 0.1 }, { stat: 'coldPct', kind: 'flat', value: 0.1 }, { stat: 'lightningPct', kind: 'flat', value: 0.1 }]),
    aur('aura-precision', 'Аура точности', 0.2, [{ stat: 'critChance', kind: 'increased', value: 0.3 }, { stat: 'accuracy', kind: 'increased', value: 0.25 }]),
    aur('aura-guard', 'Аура защиты', 0.3, [{ stat: 'armor', kind: 'increased', value: 0.3 }, { stat: 'resFire', kind: 'flat', value: 0.12 }, { stat: 'resCold', kind: 'flat', value: 0.12 }]),
    aur('aura-haste', 'Аура скорости', 0.25, [{ stat: 'moveSpeed', kind: 'increased', value: 0.15 }, { stat: 'attackSpeed', kind: 'increased', value: 0.1 }]),
  ], pas: [p('maxMana', 'increased', 0.05, 'Резерв маны'), p('manaRegen', 'increased', 0.06, 'Поток маны'), p('damagePct', 'flat', 0.03, 'Усиление'), p('castSpeed', 'increased', 0.03, 'Сосредоточение'), p('resFire', 'flat', 0.04, 'Огнестойкость'), p('resCold', 'flat', 0.04, 'Морозостойкость'), p('resLightning', 'flat', 0.04, 'Громоустойчивость'), p('resPoison', 'flat', 0.04, 'Ядоустойчивость'), p('maxHp', 'increased', 0.03, 'Дух'), p('armor', 'increased', 0.04, 'Оберег')] },
  // === Стойки (резерв выносливости) ===
  stance: { act: [
    stn('stance-berserk', 'Берсерк', 0.25, [{ stat: 'physPct', kind: 'flat', value: 0.25 }, { stat: 'attackSpeed', kind: 'increased', value: 0.15 }, { stat: 'armor', kind: 'increased', value: -0.3 }]),
    stn('stance-defense', 'Оборона', 0.2, [{ stat: 'armor', kind: 'increased', value: 0.4 }, { stat: 'blockChance', kind: 'increased', value: 0.25 }, { stat: 'moveSpeed', kind: 'increased', value: -0.1 }]),
    stn('stance-hunter', 'Ловчий', 0.2, [{ stat: 'moveSpeed', kind: 'increased', value: 0.2 }, { stat: 'evade', kind: 'increased', value: 0.3 }]),
    stn('stance-focus', 'Сосредоточение', 0.2, [{ stat: 'critMultiplier', kind: 'flat', value: 0.3 }, { stat: 'attackSpeed', kind: 'increased', value: -0.1 }]),
    stn('stance-iron', 'Железная стойка', 0.2, [{ stat: 'interruptResist', kind: 'flat', value: 0.5 }, { stat: 'maxHp', kind: 'increased', value: 0.15 }]),
  ], pas: [p('maxStamina', 'increased', 0.05, 'Выносливость'), p('staminaRegen', 'increased', 0.06, 'Второе дыхание'), p('physPct', 'flat', 0.04, 'Мощь'), p('armor', 'increased', 0.04, 'Стойка'), p('maxStamina', 'increased', 0.05, 'Закалка'), p('attackSpeed', 'increased', 0.02, 'Готовность'), p('blockChance', 'increased', 0.03, 'Защита'), p('staminaRegen', 'increased', 0.05, 'Ровное дыхание'), p('maxHp', 'increased', 0.03, 'Крепость'), p('evade', 'increased', 0.03, 'Собранность')] },
  // === Броня (пассив) ===
  'armor-light': { act: [], pas: [p('evade', 'increased', 0.07, 'Ловкость'), p('maxStamina', 'increased', 0.06, 'Лёгкость'), p('moveSpeed', 'increased', 0.03, 'Подвижность'), p('attackSpeed', 'increased', 0.03, 'Свобода движений'), p('maxHp', 'increased', 0.03, 'Жилистость'), p('resPoison', 'flat', 0.05, 'Сопр. яду'), p('staminaRegen', 'increased', 0.06, 'Дыхание'), p('evade', 'increased', 0.06, 'Скольжение'), p('critChance', 'increased', 0.04, 'Проворный глаз'), p('maxHp', 'increased', 0.03, 'Выживаемость')] },
  'armor-mail': { act: [], pas: [p('armor', 'increased', 0.07, 'Плетение'), p('maxHp', 'increased', 0.04, 'Защищённость'), p('resFire', 'flat', 0.05, 'Сопр. огню'), p('resCold', 'flat', 0.05, 'Сопр. холоду'), p('resLightning', 'flat', 0.05, 'Сопр. молнии'), p('blockChance', 'increased', 0.04, 'Прикрытие'), p('armor', 'increased', 0.06, 'Кольца'), p('maxHp', 'increased', 0.03, 'Стойкость'), p('interruptResist', 'flat', 0.03, 'Устойчивость'), p('resPoison', 'flat', 0.05, 'Сопр. яду')] },
  'armor-plate': { act: [], pas: [p('armor', 'increased', 0.09, 'Латы'), p('maxHp', 'increased', 0.05, 'Твердыня'), p('interruptResist', 'flat', 0.06, 'Незыблемость'), p('blockChance', 'increased', 0.03, 'Прикрытие'), p('armor', 'increased', 0.07, 'Пластины'), p('resFire', 'flat', 0.04, 'Сопр. огню'), p('resCold', 'flat', 0.04, 'Сопр. холоду'), p('maxHp', 'increased', 0.04, 'Несокрушимость'), p('armor', 'increased', 0.06, 'Закалённая сталь'), p('interruptResist', 'flat', 0.05, 'Стойкость')] },
  // === Щит (выносливость) ===
  shield: { act: [
    atk('shield-bash', 'Удар щитом', 6, 1.5, { damageMult: 1.0, stunSec: 0.5, ailment: ail('daze', 0.6, 0.1, 2500, 4) }),
    cst('shield-charge', 'Натиск щитом', 10, 5, 'dash', { damageMult: 1.0, dashDist: 190, stunSec: 0.4 }),
  ], pas: [p('blockChance', 'increased', 0.07, 'Мастерство блока'), p('armor', 'increased', 0.05, 'Прочность'), p('maxHp', 'increased', 0.04, 'Стойкость'), p('interruptResist', 'flat', 0.05, 'Упор'), p('blockChance', 'increased', 0.05, 'Глухая защита'), p('resFire', 'flat', 0.04, 'Сопр. огню'), p('maxStamina', 'increased', 0.05, 'Выносливость'), p('blockChance', 'increased', 0.04, 'Реакция'), p('armor', 'increased', 0.04, 'Оковка'), p('maxHp', 'increased', 0.03, 'Крепость')] },
};

// Хелпер: 5 стихийных кастов (болт/нова/поле/кара/рывок) с именами.
function elementCasts(prefix, el, ailK, mag, dur, names) {
  return [
    cst(`${prefix}-bolt`, names[0], 6, 0.4, 'boomerang', { element: el, convertPct: 0.85, damageMult: 1.1, ailment: ail(ailK, 0.4, mag, dur, 4) }),
    cst(`${prefix}-nova`, names[1], 12, 1.6, 'nova', { element: el, convertPct: 0.85, damageMult: 1.4, radius: 150, ailment: ail(ailK, 0.6, mag, dur, 5) }),
    cst(`${prefix}-ground`, names[2], 16, 4, 'ground', { element: el, convertPct: 0.85, damageMult: 1.5, radius: 160, ailment: ail(ailK, 0.6, mag, dur, 5) }),
    cst(`${prefix}-meteor`, names[3], 20, 6, 'meteor', { element: el, convertPct: 0.85, damageMult: 2.2, radius: 150, ailment: ail(ailK, 0.8, mag, dur + 500, 5) }),
    cst(`${prefix}-dash`, names[4], 10, 5, 'dash', { element: el, convertPct: 0.85, damageMult: 0.8, dashDist: 200 }),
  ];
}
// Хелпер: 10 пассивов стихии (3 на %-урон стихией + статус + общие маг-статы).
function elemPas(elStat, names) {
  return [
    p(elStat, 'flat', 0.06, names[0]), p(elStat, 'flat', 0.05, names[1]), p(elStat, 'flat', 0.05, names[2]),
    p('ailmentPct', 'flat', 0.06, names[3]), p('castSpeed', 'increased', 0.04, 'Скорость каста'),
    p('maxMana', 'increased', 0.05, 'Резерв маны'), p('manaRegen', 'increased', 0.06, 'Поток маны'),
    p('critChance', 'increased', 0.05, 'Магический крит'), p('critMultiplier', 'flat', 0.06, 'Всплеск'),
    p('damagePct', 'flat', 0.04, 'Мощь стихии'),
  ];
}

/**
 * ВСТАВКИ ПО ВЕТКАМ. Ветка отдаёт то, чем сама занимается: мечи режут, булавы оглушают,
 * стихии дают свою стихию. Раздача живёт ЗДЕСЬ, а не в JSON вставок, чтобы структура дерева
 * собиралась из одного места; сам контент вставки — в `skill-inserts.json`.
 */
const BRANCH_INS = {
  'b-sword1h': ['ins-serrated'],
  'b-mace1h': ['ins-sweep'],
  'b-sword2h': ['ins-wide-arc'],
  'b-mace2h': ['ins-heavy-blow'],
  'b-crossbow': ['ins-piercing'],
  'b-dual': ['ins-flurry'],
  'b-fire': ['ins-flame-edge', 'ins-kindling'],
  'b-cold': ['ins-frost-edge', 'ins-hoarfrost', 'ins-cold-wave'],
  'b-lightning': ['ins-arc-burst'],
  'b-aura': ['ins-thrift'],
  'b-stance': ['ins-quickening'],
  'b-armor-light': ['ins-swiftness'],
  'b-armor-plate': ['ins-ward'],
  'b-shield': ['ins-shove'],
};

// ── 25 веток: метаданные (гейт/ресурс/группа) + контент из C ──
const B = [
  { id: 'b-sword1h', name: 'Мечи', group: 'melee1h', res: 'stamina', gate: { weaponClasses: ['sword'], hands: 'one' }, c: 'sword1h' },
  { id: 'b-axe1h', name: 'Топоры', group: 'melee1h', res: 'stamina', gate: { weaponClasses: ['axe'], hands: 'one' }, c: 'axe1h' },
  { id: 'b-mace1h', name: 'Булавы', group: 'melee1h', res: 'stamina', gate: { weaponClasses: ['mace'], hands: 'one' }, c: 'mace1h' },
  { id: 'b-dagger', name: 'Кинжалы', group: 'melee1h', res: 'stamina', gate: { weaponClasses: ['dagger'], hands: 'one' }, c: 'dagger' },
  { id: 'b-sword2h', name: 'Двуручные мечи', group: 'melee2h', res: 'stamina', gate: { weaponClasses: ['sword'], hands: 'two' }, c: 'sword2h' },
  { id: 'b-axe2h', name: 'Двуручные топоры', group: 'melee2h', res: 'stamina', gate: { weaponClasses: ['axe'], hands: 'two' }, c: 'axe2h' },
  { id: 'b-mace2h', name: 'Двуручные молоты', group: 'melee2h', res: 'stamina', gate: { weaponClasses: ['mace'], hands: 'two' }, c: 'mace2h' },
  { id: 'b-spear', name: 'Копья', group: 'melee2h', res: 'stamina', gate: { weaponClasses: ['spear'], hands: 'two' }, c: 'spear' },
  { id: 'b-halberd', name: 'Алебарды', group: 'melee2h', res: 'stamina', gate: { weaponClasses: ['halberd'], hands: 'two' }, c: 'halberd' },
  { id: 'b-bow', name: 'Луки', group: 'ranged', res: 'stamina', gate: { weaponClasses: ['bow'] }, c: 'bow' },
  { id: 'b-crossbow', name: 'Арбалеты', group: 'ranged', res: 'stamina', gate: { weaponClasses: ['crossbow'] }, c: 'crossbow' },
  { id: 'b-dual', name: 'Парное оружие', group: 'dual', res: 'stamina', gate: { requiresDual: true }, c: 'dual' },
  { id: 'b-wand', name: 'Жезлы', group: 'weapon-magic', res: 'mana', gate: { weaponClasses: ['wand'] }, c: 'wand' },
  { id: 'b-staff', name: 'Посохи', group: 'weapon-magic', res: 'mana', gate: { weaponClasses: ['staff'] }, c: 'staff' },
  { id: 'b-fire', name: 'Огонь', group: 'element', res: 'mana', gate: { damageKind: 'magical' }, c: 'fire' },
  { id: 'b-cold', name: 'Холод', group: 'element', res: 'mana', gate: { damageKind: 'magical' }, c: 'cold' },
  { id: 'b-lightning', name: 'Молния', group: 'element', res: 'mana', gate: { damageKind: 'magical' }, c: 'lightning' },
  { id: 'b-poison', name: 'Яд', group: 'element', res: 'mana', gate: { damageKind: 'magical' }, c: 'poison' },
  { id: 'b-curse', name: 'Проклятья', group: 'curse', res: 'mana', gate: { damageKind: 'magical' }, c: 'curse' },
  { id: 'b-aura', name: 'Ауры', group: 'aura', res: 'mana', gate: {}, c: 'aura' },
  { id: 'b-stance', name: 'Стойки', group: 'stance', res: 'stamina', gate: {}, c: 'stance' },
  { id: 'b-armor-light', name: 'Лёгкая броня', group: 'armor', res: 'none', gate: {}, c: 'armor-light' },
  { id: 'b-armor-mail', name: 'Кольчуга', group: 'armor', res: 'none', gate: {}, c: 'armor-mail' },
  { id: 'b-armor-plate', name: 'Тяжёлая броня', group: 'armor', res: 'none', gate: {}, c: 'armor-plate' },
  { id: 'b-shield', name: 'Щит', group: 'shield', res: 'stamina', gate: {}, c: 'shield' },
];

/**
 * СЕТКА ВЕТКИ СТРОИТСЯ ИЗ ЕЁ КОНТЕНТА, а не берётся фиксированным шаблоном: сколько у ветки
 * активок, вставок и пассивов — столько узлов и ярусов. Раньше шаблон жёстко клал ТРИ узла
 * на ярус, и на кольце радиуса ~177 оказывалось 96 узлов — по 11.6 единицы на узел при иконке
 * в 15. Отсюда и 128 пар реально перекрывающихся квадратов.
 *
 * Правило простое: НЕ БОЛЬШЕ ДВУХ УЗЛОВ НА ЯРУС. Слева идёт «интересное» (активка или вставка),
 * справа — пассив; когда что-то кончается, ярус доклеивается тем, что осталось.
 *
 * Возвращает строки [key, kind('a'|'i'|'p'), sub(-1..1), tier, parentKey].
 */
function buildTemplate(nAct, nIns, nPas) {
  const rows = [['e', 'p', 0, 0, null]];
  // Активки и вставки вперемешку: сперва активка, потом вставка — чтобы ветка не начиналась
  // с трёх вставок подряд и не заканчивалась стеной пассивов.
  const spicy = [];
  for (let i = 0; i < Math.max(nAct, nIns); i++) {
    if (i < nAct) spicy.push(['a', i]);
    if (i < nIns) spicy.push(['i', i]);
  }
  let pas = 0, tier = 1, prevTier = ['e'];
  while (spicy.length || pas < nPas) {
    const slots = [];
    if (spicy.length) slots.push(spicy.shift());
    if (pas < nPas) slots.push(['p', pas++]);
    else if (spicy.length) slots.push(spicy.shift());
    const keys = [];
    slots.forEach(([kind, idx], j) => {
      const sub = slots.length === 1 ? 0 : (j === 0 ? -1 : 1);
      const key = `${kind}${idx + 1}`;
      rows.push([key, kind, sub, tier, prevTier[Math.min(j, prevTier.length - 1)]]);
      keys.push(key);
    });
    prevTier = keys;
    tier++;
  }
  return rows;
}

/** Уровень по ярусу. Дальше от центра — позже открывается; за шестым ярусом упирается в 30. */
const TIER_LVL = [1, 6, 12, 18, 24, 30];
const lvlAt = (tier) => TIER_LVL[Math.min(tier, TIER_LVL.length - 1)];

// ── Радиальная раскладка ЕДИНОГО древа (как пассивка): из центра ветви расходятся во все стороны.
// Лево = боевые (выносливость), право = магия (мана), низ = броня (none), верх = классовые.
// (sub -1..1) → перпендикулярное смещение веера, (tier 0..5) → радиус от центра.
const R0 = 190, TIER_R = 95;
/** Веер занимает эту долю УГЛОВОГО КОРИДОРА ветки (расстояние до ближайшей соседней ветки). */
const SUB_FRAC = 0.28, SUB_MIN = 14, SUB_MAX = 34;
/** Радиальный зигзаг: левый узел яруса чуть ближе к центру, правый — чуть дальше. */
const RSTAG = 22;
/** Минимальный зазор между любыми двумя видимыми узлами; ниже — генератор падает. */
const MIN_GAP = 30;

/**
 * ВЕЕР — ДОЛЯ КОРИДОРА, А НЕ КОНСТАНТА. Раньше было `SUB_A = 28` при любом радиусе: на радиусе 288
 * соседние ветки разведены на 58 единиц, а два встречных веера съедали 56 — оставалось 2.
 * Теперь ширина веера считается от того, сколько места у ветки есть, и вдобавок узлы яруса
 * разъезжаются ПО РАДИУСУ (`RSTAG`) — тогда даже сблизившиеся по углу узлы стоят на разных кольцах.
 */
function radialXY(angleDeg, corridorRad, sub, tier) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);          // радиальное направление (мат. координаты)
  const r0 = R0 + tier * TIER_R;
  const r = r0 + sub * RSTAG;                        // зигзаг: −1 ближе, +1 дальше
  const subA = Math.min(SUB_MAX, Math.max(SUB_MIN, r0 * corridorRad * SUB_FRAC));
  const mx = dx * r + -dy * (sub * subA);            // + перпендикуляр (−dy, dx)
  const my = dy * r + dx * (sub * subA);
  return { x: Math.round(mx), y: Math.round(-my) };   // экран: y вниз, +угол = вверх
}
// Углы веток по ресурсу (порядок B сохраняет тематическую группировку внутри сектора).
const spread = (n, a0, a1, i) => (n <= 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * i) / (n - 1));
const stamB = B.filter((b) => b.res === 'stamina');
const manaB = B.filter((b) => b.res === 'mana');
const noneB = B.filter((b) => b.res === 'none');
const BRANCH_ANGLE = new Map();
// СЕКТОРА РАЗВЕДЕНЫ ТАК, ЧТОБЫ МЕЖДУ ГРУППАМИ ОСТАВАЛСЯ ЗАЗОР. Раньше магия кончалась на −66°,
// а броня начиналась на 288° (=−72°) — шесть градусов, и на входном кольце это 18 единиц: входы
// «Ауры» и «Тяжёлой брони» просто налезали друг на друга. Теперь магия ужата до −52°.
stamB.forEach((b, i) => BRANCH_ANGLE.set(b.id, spread(stamB.length, 100, 250, i))); // левая дуга (сверху вниз)
manaB.forEach((b, i) => BRANCH_ANGLE.set(b.id, spread(manaB.length, 68, -52, i)));  // правая дуга (сверху вниз)
noneB.forEach((b, i) => BRANCH_ANGLE.set(b.id, [262, 274, 286][i] ?? 274));         // нижний сектор (броня)

/** Угловое расстояние между двумя направлениями, град (0..180). */
const angDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Коридор ветки — угол до БЛИЖАЙШЕЙ соседней ветки. Классовые ветки делят вершину (в игре и в
 * редакторе виден только свой класс), поэтому друг друга соседями не считают.
 */
function corridorRad(id) {
  const a = BRANCH_ANGLE.get(id);
  const mine = id.startsWith('b-class-');
  let best = 180;
  for (const [oid, oa] of BRANCH_ANGLE) {
    if (oid === id) continue;
    if (mine && oid.startsWith('b-class-')) continue;
    best = Math.min(best, angDist(a, oa));
  }
  return (best * Math.PI) / 180;
}

/**
 * САМОПРОВЕРКА РАСКЛАДКИ. Игрок видит общие ветки плюс ОДНУ свою классовую — значит и проверять
 * надо каждый такой набор отдельно, а не всё дерево разом (иначе наложение классовых веток друг
 * на друга, которого игрок никогда не увидит, завалило бы проверку).
 */
function assertNoOverlap(nodes, branches) {
  const universal = branches.filter((b) => !b.classId).map((b) => b.id);
  const classes = branches.filter((b) => b.classId).map((b) => b.id);
  let worst = { d: Infinity, a: '', b: '', set: '' };
  for (const cls of classes.length ? classes : [null]) {
    const vis = new Set(cls ? [...universal, cls] : universal);
    const ns = nodes.filter((n) => vis.has(n.branchId));
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const d = Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
        if (d < worst.d) worst = { d, a: ns[i].id, b: ns[j].id, set: cls ?? 'общие' };
      }
    }
  }
  if (worst.d < MIN_GAP) {
    throw new Error(`Раскладка налезает: ${worst.a} и ${worst.b} в ${worst.d.toFixed(2)} ед. ` +
      `(набор «${worst.set}», нужно ≥ ${MIN_GAP}). Крути R0/TIER_R/SUB_FRAC/RSTAG.`);
  }
  return worst;
}

const branches = [], entryNodes = [], edges = [], nodes = [];

B.forEach((br) => {
  const angle = BRANCH_ANGLE.get(br.id);
  const content = C[br.c];
  const acts = [...content.act];
  const pas = [...content.pas];
  const resource = br.res === 'none' ? 'mana' : br.res;
  const idOf = (k) => `${br.id}-${k}`;
  const placed = {};
  const corr = corridorRad(br.id);
  const inserts = (BRANCH_INS[br.id] || []).map((id) => {
    const ins = insById.get(id);
    if (!ins) throw new Error(`Ветка ${br.id}: вставки «${id}» нет в skill-inserts.json`);
    return ins;
  });
  const tpl = buildTemplate(acts.length, inserts.length, pas.length);
  const lastAct = `a${acts.length}`, lastPas = `p${pas.length}`;

  for (const [key, kind, sub, tier, parent] of tpl) {
    let node;
    const { x, y } = radialXY(angle, corr, sub, tier);
    const common = { id: idOf(key), branchId: br.id, cost: { type: 'points', amount: 1 }, requires: [], levelReq: lvlAt(tier), x, y, notable: key === lastAct || key === lastPas };
    if (kind === 'a' && acts.length) {
      const ab = acts.shift();
      ab.a = { ...ab.a, resource, ...abilityGate(br.gate) };
      node = { ...common, kind: 'active', name: ab.name, description: describeAbility(ab.a), maxRank: 20, effect: { active: ab.a } };
    } else if (kind === 'i' && inserts.length) {
      // Узел-вставка: рангов десять, и ранг задаёт СИЛУ вставки, а не только доступ к ней.
      const ins = inserts.shift();
      node = { ...common, kind: 'passive', name: ins.name, description: describeInsertNode(ins), maxRank: 10, effect: { grantsInsert: ins.id } };
    } else if (pas.length) {
      const [stat, mkind, value, label, statLabel] = pas.shift();
      const pct = Math.round(value * 1000) / 10;
      node = { ...common, kind: 'passive', name: label, description: `+${pct}% ${statLabel ?? SL[stat] ?? label} за ранг.`, maxRank: 4, effect: { modifiers: [{ stat, kind: mkind, value }] } };
    } else {
      continue;
    }
    placed[key] = node.id;
    nodes.push(node);
    if (parent && placed[parent]) edges.push([placed[parent], node.id]);
  }

  const entryId = idOf('e');
  entryNodes.push(entryId);
  branches.push({ id: br.id, name: br.name, group: br.group, resource: br.res, ...br.gate, entryNode: entryId });
});

// ── Сигнатурные ветки классов (из старого skills-active): 6 актив + 4 пассив, гейт только по классу ──
const CLASS_META = {
  warrior: { name: 'Дружина', res: 'stamina' },
  mage: { name: 'Стихийная мощь', res: 'mana' },
  archer: { name: 'Ловушки', res: 'stamina' },
  zastupnik: { name: 'Заступничество', res: 'stamina' },
  vyuga: { name: 'Валькирия', res: 'stamina' },
  arbalest: { name: 'Уловки', res: 'stamina' },
  vorozheya: { name: 'Порча', res: 'mana' },
};
let oldActive = [];
try { oldActive = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/shared/src/config/data/skills-active.json'), 'utf8')); } catch { /* нет файла */ }
Object.entries(CLASS_META).forEach(([classId, meta]) => {
  const tree = oldActive.find((t) => t.classId === classId);
  if (!tree) return;
  const aq = tree.nodes.filter((n) => n.effect && n.effect.active).slice(0, 6);
  const pq = tree.nodes.filter((n) => n.effect && n.effect.modifiers && !n.effect.active).slice(0, 4);
  const bid = `b-class-${classId}`;
  const idOf = (k) => `${bid}-${k}`;
  const placed = {};
  BRANCH_ANGLE.set(bid, 90);
  const corr = corridorRad(bid);
  const cIns = (BRANCH_INS[bid] || []).map((id) => {
    const ins = insById.get(id);
    if (!ins) throw new Error(`Ветка ${bid}: вставки «${id}» нет в skill-inserts.json`);
    return ins;
  });
  const tpl = buildTemplate(aq.length, cIns.length, pq.length);
  for (const [key, kind, sub, tier, parent] of tpl) {
    let node;
    // Класс — верхний сектор (угол 90°). В игре виден только свой класс, поэтому все классы делят вершину.
    const { x, y } = radialXY(90, corr, sub, tier);
    const common = { id: idOf(key), branchId: bid, cost: { type: 'points', amount: 1 }, requires: [], levelReq: lvlAt(tier), x, y, notable: false };
    if (kind === 'a' && aq.length) {
      const src = aq.shift();
      const a = { ...src.effect.active, resource: meta.res };
      delete a.attackTypes; delete a.damageKinds; delete a.weaponClasses; delete a.hands; // класс-скиллы — любым оружием
      // Описание берём ИЗ ЧИСЕЛ, а не из легаси-файла: там лежало «Активный скилл: <имя>».
      node = { ...common, kind: 'active', name: src.name, description: describeAbility(a), maxRank: src.maxRank ?? 20, effect: { active: a } };
    } else if (kind === 'i' && cIns.length) {
      const ins = cIns.shift();
      node = { ...common, kind: 'passive', name: ins.name, description: describeInsertNode(ins), maxRank: 10, effect: { grantsInsert: ins.id } };
    } else if (pq.length) {
      const src = pq.shift();
      node = { ...common, kind: 'passive', name: src.name, description: describePassive(src.effect.modifiers, src.description), maxRank: src.maxRank ?? 4, effect: { modifiers: src.effect.modifiers } };
    } else continue;
    placed[key] = node.id;
    nodes.push(node);
    if (parent && placed[parent]) edges.push([placed[parent], node.id]);
  }
  const entryId = idOf('e');
  entryNodes.push(entryId);
  branches.push({ id: bid, name: meta.name, group: 'class', classId, resource: meta.res, entryNode: entryId });
});

// Раскладка проверяется ДО записи: лучше упасть, чем положить в репозиторий кашу.
const worst = assertNoOverlap(nodes, branches);
writeFileSync(out, JSON.stringify({ branches, entryNodes, edges, nodes }, null, 2) + '\n');
const classCount = branches.filter((b) => b.classId).length;
console.log(`Веток: ${branches.length} (класс: ${classCount}), узлов: ${nodes.length}, рёбер: ${edges.length} → ${out}`);
console.log(`Минимальный зазор: ${worst.d.toFixed(1)} ед. (${worst.a} ↔ ${worst.b}, набор «${worst.set}»), порог ${MIN_GAP}`);
