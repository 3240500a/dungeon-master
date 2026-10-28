export * from './rng.js';
export * from './uuid.js';
export * from './stats.js';
export * from './combat.js';
// ⭐ D4: одно правило времени баффа — схема, редактор, ядро и фаззер спрашивают его отсюда.
export * from './buffTiming.js';
export * from './xp.js';
export * from './itemgen.js';
export * from './itemName.js';
export * from './ruAgree.js';
// ⚠ Разбор и трофеи нужны НЕ только сессии: редактор строит по ним таблицы дропа, и считать
// их там своей формулой значило бы завести второй источник правды (правило «редактор и игра
// видят одно и то же»).
export * from './salvage.js';
export * from './trophy.js';
// Ковка оружия из деталей: одно ядро для сервера, окна ковки и песочницы редактора.
export * from './craft.js';
export * from './craftType.js';
export * from './craftCard.js';
export * from './itemReq.js';
export * from './itemDescribe.js';
export * from './monstergen.js';
export * from './monsterDerive.js';
// ⭐ Г8-3: ступень снаряжения монстра — ПУБЛИЧНЫЙ шов: её спрашивает вкладка «Круг забега» редактора, чтобы
// колонка «гир монстров» в карте этажей считалась ТЕМ ЖЕ правилом, что в игре (а не своей таблицей порогов).
export * from './monsterGearTier.js';
export * from './spawnWeight.js';
export * from './power.js';
export * from './skills.js';
export * from './playerCombat.js';
export * from './versatile.js';
export * from './bladeStats.js';
export * from './resolveWeapon.js';
export * from './resolveArmor.js';
export * from './hitMaterial.js';
