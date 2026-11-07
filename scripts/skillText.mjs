// ⭐ ТЕКСТ ОПИСАНИЙ УЗЛОВ — из чисел узла, один модуль на оба генератора (`gen-skill-tree.mjs`, `gen-passive.mjs`).
// Без побочных эффектов: его же грузит сухой прогон (`--out`), чтобы сверить описания с данными, не трогая JSON.
//
// ⭐⭐ i18n Ф3, этап 2 (07.11): перевод поймал описания, которые врали и русскому игроку — «+200% strength за ранг» у плоских +2
// атрибута, «+1000% к мане» у плоских +10, «+400% addFire», «отбрасывает на 0» при 0.35, «+2%» при 1.5 %. Три правила вместо прежних:
//   1. проценты или число — от РОДА СТАТА (`STAT_TEXT`: доля или абсолют) и вида мода, а не «всегда %»;
//   2. подпись — у КАЖДОГО стата, который встретит генератор; незнакомый id — падение, а не сырой id в русском тексте;
//   3. дробные значения не округляются в ноль: проценты — с десятой, числа — с сотыми.

/**
 * Род стата и подпись «к …» для «+N …». `frac` — доля (плоский мод уже процентные пункты: physPct 0.05 = +5 %),
 * `abs` — абсолют (плоский мод — число: strength 2 = +2, maxMana 10 = +10). Вид `increased` — всегда проценты.
 * Род взят из базы `deriveStats` (`formulas/stats.ts`): critMultiplier 1.5, attackSpeed 1 — доли; moveSpeed 120, accuracy 20+ — абсолюты.
 */
export const STAT_TEXT = {
  // ── доли ──
  critChance: ['к шансу крита', 'frac'], critMultiplier: ['к множителю крита', 'frac'],
  attackSpeed: ['к скорости атаки', 'frac'], castSpeed: ['к скорости каста', 'frac'], attackMoveMult: ['к шагу в атаке', 'frac'],
  armorPen: ['к пробою брони цели', 'frac'], blockChance: ['к блоку', 'frac'], interruptResist: ['к стойкости к прерыванию', 'frac'],
  damagePct: ['ко всему урону', 'frac'], physPct: ['к физ. урону', 'frac'], firePct: ['к урону огнём', 'frac'],
  coldPct: ['к урону холодом', 'frac'], lightningPct: ['к урону молнией', 'frac'], poisonPct: ['к урону ядом', 'frac'],
  ailmentPct: ['к наложению статусов', 'frac'], ailmentDurPct: ['к длительности статусов', 'frac'],
  resFire: ['к сопр. огню', 'frac'], resCold: ['к сопр. холоду', 'frac'], resLightning: ['к сопр. молнии', 'frac'], resPoison: ['к сопр. яду', 'frac'],
  lifeLeechPct: ['к вампиризму жизни', 'frac'], manaLeechPct: ['к вампиризму маны', 'frac'],
  woundChancePct: ['к шансу раны', 'frac'], woundPowerPct: ['к силе раны', 'frac'], woundDurPct: ['к длительности раны', 'frac'],
  bleedChancePct: ['к шансу кровотечения', 'frac'], bleedPowerPct: ['к силе кровотечения', 'frac'], bleedDurPct: ['к длительности кровотечения', 'frac'],
  sunderChancePct: ['к шансу увечья', 'frac'], sunderPowerPct: ['к силе увечья', 'frac'], sunderDurPct: ['к длительности увечья', 'frac'],
  dazeChancePct: ['к шансу ошеломления', 'frac'], dazePowerPct: ['к силе ошеломления', 'frac'], dazeDurPct: ['к длительности ошеломления', 'frac'],
  burnChancePct: ['к шансу поджига', 'frac'], burnPowerPct: ['к силе поджига', 'frac'], burnDurPct: ['к длительности поджига', 'frac'],
  poisonChancePct: ['к шансу отравления', 'frac'], poisonPowerPct: ['к силе отравления', 'frac'], poisonDurPct: ['к длительности отравления', 'frac'],
  shockChancePct: ['к шансу шока', 'frac'], shockPowerPct: ['к силе шока', 'frac'], shockDurPct: ['к длительности шока', 'frac'],
  freezeChancePct: ['к шансу заморозки', 'frac'], freezePowerPct: ['к силе заморозки', 'frac'], freezeDurPct: ['к длительности заморозки', 'frac'],
  // ── абсолюты ──
  strength: ['к силе', 'abs'], dexterity: ['к ловкости', 'abs'], intelligence: ['к интеллекту', 'abs'], vitality: ['к живучести', 'abs'],
  maxHp: ['к здоровью', 'abs'], maxMana: ['к мане', 'abs'], maxStamina: ['к выносливости', 'abs'],
  minDamage: ['к мин. урону', 'abs'], maxDamage: ['к макс. урону', 'abs'],
  armor: ['к броне', 'abs'], accuracy: ['к меткости', 'abs'], evade: ['к уклонению', 'abs'], moveSpeed: ['к скорости движения', 'abs'],
  hpRegen: ['к регену HP', 'abs'], manaRegen: ['к регену маны', 'abs'], staminaRegen: ['к регену выносливости', 'abs'],
  // Плоская прибавка стихии к удару: «+4 урона огнём» — родительным, чтобы не спутать с «+20% к урону огнём» (firePct).
  addFire: ['урона огнём', 'abs'], addCold: ['урона холодом', 'abs'], addLightning: ['урона молнией', 'abs'], addPoison: ['урона ядом', 'abs'],
  lifeOnKill: ['здоровья за убийство', 'abs'], manaOnKill: ['маны за убийство', 'abs'],
};

/** Подпись и род стата; незнакомый id — ошибка генератора (иначе сырой `addFire` уезжает в русский текст). */
export function statText(stat) {
  const t = STAT_TEXT[stat];
  if (!t) throw new Error(`Описание узла: у стата «${stat}» нет подписи — добавь его в STAT_TEXT (scripts/skillText.mjs)`);
  return { label: t[0], unit: t[1] };
}

/** Число без хвоста: до сотых (0.35 остаётся 0.35, а не «0»). */
export const num = (x) => String(Math.round(x * 100) / 100);
/** Процент с десятой: 0.015 → «1.5%», 0.008 → «0.8%» (было «2%» / «1%»). */
export const pct = (x) => `${Math.round(x * 1000) / 10}%`;
/** Заглавная первая буква: фразы собираются из кусков, и начало предложения не должно быть строчным. */
export const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** Величина мода без знака: проценты у `increased` и у долей, число — у плоского абсолюта. */
export function modAmount(stat, kind, value) {
  const { unit } = statText(stat);
  if (kind !== 'flat' && kind !== 'increased') throw new Error(`Описание узла: вид мода «${kind}» у «${stat}» не разобран`);
  const abs = Math.abs(value);
  return kind === 'increased' || unit === 'frac' ? pct(abs) : num(abs);
}

/** «+N к …» / «−N% к …» — один мод узла. */
export function modPhrase(m) {
  return `${m.value < 0 ? '−' : '+'}${modAmount(m.stat, m.kind, m.value)} ${statText(m.stat).label}`;
}

const AIL_RU = {
  wound: 'рану', bleed: 'кровотечение', sunder: 'увечье', daze: 'ошеломление',
  burn: 'поджиг', poison: 'отравление', shock: 'шок', freeze: 'обморожение',
};
const EL_RU = { physical: 'физическим', fire: 'огнём', cold: 'холодом', lightning: 'молнией', poison: 'ядом' };
const RES_RU = { stamina: 'выносливости', mana: 'маны' };
const SHAPE_RU = { nova: 'взрыв вокруг себя', ground: 'зона на земле', meteor: 'удар с неба',
  dash: 'рывок сквозь врагов', leap: 'прыжок', boomerang: 'снаряд' };
/** Словарь — с проверкой: незнакомое значение тоже не печатаем сырым. */
const word = (dict, id, what) => {
  const w = dict[id];
  if (w === undefined) throw new Error(`Описание узла: ${what} «${id}» без русского слова — добавь в scripts/skillText.mjs`);
  return w;
};

/** Кусок про накладываемый статус — общий для атак, кастов и проклятий. */
function ailPhrase(al) {
  if (!al || !al.kind) return null;
  const dur = al.durationMs ? ` на ${num(al.durationMs / 1000)} с` : '';
  const st = al.maxStacks > 1 ? `, до ${al.maxStacks} стаков` : '';
  return `${pct(al.chance)} наложить ${word(AIL_RU, al.kind, 'статус')}${dur}${st}`;
}

/** Русская форма по числу: 1 снаряд, 2–4 снаряда, 5+ снарядов (11–14 — «снарядов»). Было «5 снаряда веером». */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a >= 11 && a <= 14) return many;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

/** Описание способности из её полей. Порядок фраз — от главного к деталям; что не задано, то и не упоминается. */
export function describeAbility(a) {
  const out = [];
  if (a.category === 'attack') {
    const parts = [`Удар оружием ×${num(a.damageMult ?? 1)} к урону`];
    if (a.hits > 1) parts.push(`${a.hits} ${plural(a.hits, 'удар', 'удара', 'ударов')} подряд`);
    if (a.count > 1) parts.push(`${a.count} ${plural(a.count, 'снаряд', 'снаряда', 'снарядов')} веером`);
    if (a.speed && a.speed !== 1) parts.push(`скорость ×${num(a.speed)}`);
    if (a.arcMult && a.arcMult !== 1) parts.push(`дуга ×${num(a.arcMult)}`);
    if (a.rangeMult && a.rangeMult !== 1) parts.push(`дальность ×${num(a.rangeMult)}`);
    if (a.pierce) parts.push('пробивает насквозь');
    out.push(parts.join(', ') + '.');
  } else if (a.category === 'cast') {
    const parts = [`${word(SHAPE_RU, a.shape, 'форма каста')} ×${num(a.damageMult ?? 1)} к урону`];
    if (a.radius) parts.push(`радиус ${num(a.radius)}`);
    if (a.dashDist) parts.push(`рывок на ${num(a.dashDist)}`);
    out.push(cap(parts.join(', ')) + '.');
  } else if (a.category === 'curse') {
    out.push(`Проклятие по площади${a.radius ? `, радиус ${num(a.radius)}` : ''}.`);
  } else if (a.category === 'aura' || a.category === 'stance') {
    out.push(`${a.category === 'aura' ? 'Аура' : 'Стойка'}: резервирует ${pct(a.reservePct ?? 0)} пула.`);
  } else if (a.category === 'buff') {
    out.push(`Усиление на ${num(a.durationSec ?? 0)} с.`);
  }
  // Состав урона: стихия появляется только там, где реально меняет пакет.
  if (a.element && a.element !== 'physical') {
    const el = word(EL_RU, a.element, 'стихия');
    if (a.convertPct) out.push(`${pct(a.convertPct)} урона переводится в урон ${el}.`);
    else if (a.addElementPct) out.push(`Сверху ${pct(a.addElementPct)} урона ${el}.`);
    else out.push(`Бьёт ${el}.`);
  }
  const ail = ailPhrase(a.ailment);
  if (ail) out.push(cap(ail) + '.');
  const ctl = [];
  // ⚠ Отброс — в единицах мира (как радиус и рывок), бывает и дробным: Math.round печатал 0.35 как «0».
  if (a.knockback) ctl.push(`отбрасывает на ${num(a.knockback)}`);
  if (a.stunSec) ctl.push(`оглушает на ${num(a.stunSec)} с`);
  if (a.knockdownChance) ctl.push(`${pct(a.knockdownChance)} сбить с ног`);
  if (ctl.length) out.push(cap(ctl.join(', ')) + '.');
  // Модификаторы аур/стоек/баффов — иначе про них не сказано вообще ничего.
  for (const m of a.buffMods || []) out.push(`${modPhrase(m)}.`);
  const cost = [];
  if (a.manaCost) cost.push(`${num(a.manaCost)} ${RES_RU[a.resource] || a.resource || ''}`.trim());
  if (a.cooldown) cost.push(`откат ${num(a.cooldown)} с`);
  if (a.castTimeSec) cost.push(`каст ${num(a.castTimeSec)} с`);
  if (cost.length) out.push(`Цена: ${cost.join(', ')}.`);
  return out.join(' ');
}

/** Описание пассива из его модификаторов: «+2 к силе, +1.5% к скорости атаки за ранг.» */
export function describePassive(mods, fallback) {
  const parts = (mods || []).map(modPhrase);
  if (!parts.length) return fallback || '';
  return `${parts.join(', ')} за ранг.`;
}

const POOL_RU = { mana: 'маны', stamina: 'выносливости' };
/**
 * Описание узла-вставки: что открывает, что вставка делает и чем за это платят.
 * ⭐ Цена вставки — ПЛОСКАЯ (`cost` в пуле `costPool`, схема `skill-inserts`), а не доля цены носителя: прежний `costMult`
 * снят из данных, и генератор печатал «стоимость ×NaN». `carrier` — в ресурсе самого скила («стоимость +2»), свой пул — словом.
 */
export function describeInsertNode(ins, typeName) {
  const cost = [];
  if (ins.cost) {
    const pool = ins.costPool ?? 'carrier';
    const amount = `${ins.cost < 0 ? '−' : '+'}${num(Math.abs(ins.cost))}`;
    cost.push(pool === 'carrier' ? `стоимость ${amount}` : `${amount} ${word(POOL_RU, pool, 'пул вставки')}`);
  }
  if ((ins.cooldownMult ?? 1) !== 1) cost.push(`откат ×${num(ins.cooldownMult)}`);
  // Про конверсию говорим ОТДЕЛЬНО: она гасит физический статус оружия (packet.physical → 0),
  // и без этой строчки игрок считает пропавшее кровотечение багом.
  const conv = ins.tune && ins.tune.convertPct >= 1
    ? ' Полная конверсия убирает физические статусы оружия (кровотечение, увечье и прочие).' : '';
  return `Открывает вставку «${ins.name}» (${typeName}). ${ins.description}` +
    (cost.length ? ` Носитель платит: ${cost.join(', ')}.` : '') + conv +
    ' Ранг узла усиливает вставку.';
}
