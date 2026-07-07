# CONFIG_SCHEMA.md — конфиги игры

Все конфиги живут в `packages/shared/src/config/data/*.json` и валидируются zod-схемами из
`packages/shared/src/config/schemas.ts`. Игра и HTML-редактор используют одни и те же схемы.

| Ключ | Файл | Назначение | Основные поля |
|---|---|---|---|
| balance | data/balance.json | глобальный баланс | xpTable (кап ~90), pointsPerLevel, deathPenalty, weaponAttrScaling, forgePrices, respecCost, inventory(cols,rows), autoPickup[], passiveRankCostGrowth |
| classes | data/classes.json | стартовые классы | id, name, startAttributes, startWeaponId, activeTreeId, sprite |
| items.base | data/items-base.json | базы предметов | id, slot (incl. belt), weaponType?, baseStats, requirements, itemLevel, gridW, gridH |
| affixes | data/affixes.json | префиксы/суффиксы | id, kind, stat, tiers[min,max,ilvl] |
| uniques | data/uniques.json | уникальные предметы | id, baseId, fixedAffixes |
| monsters | data/monsters.json | монстры | id, name, hp, minDamage, maxDamage, damageType, attackSpeed, armor, accuracy, evade, blockChance, critChance, res*, xp, ai, sprite, vision* |
| monster-affixes | data/monster-affixes.json | аффиксы монстров | id, name, mult{}, add{}, damageType? (огненный/быстрый/бронированный/…) |
| packs | data/packs.json | пачки монстров по типам комнат | roomType, min, max, champion |
| dungeons | data/dungeons.json | темы подземелий | id, tileset, monsterPool, dropBias, modifiers |
| skills-active | data/skills-active.json | активные деревья (по классам) | classId, branches[], nodes[] |
| skills-passive | data/skills-passive.json | пассивное общее дерево | nodes[], edges[], entryNodes[] |
| quests.main | data/quests-main.json | сюжетные цепочки | id, steps[], objectives[], rewards |
| quests.random | data/quests-random.json | шаблоны случайных квестов | id, objectiveType, ranges, rewardPool |

## Стоимость узлов скиллов
Общий формат `SkillNode.cost = { type: 'points' | 'gold', amount }`. Активные узлы —
`points`, пассивные — `gold`. Правило можно поменять прямо в конфиге, код универсален.

## Требования оружия (weaponType → атрибут)
`melee → Strength`, `ranged → Dexterity`, `magic → Intelligence`. Масштаб урона от
атрибута задаётся в `balance.weaponAttrScaling`. Требования конкретной базы — в
`items.base[].requirements`.

## Live-apply
HTML-редактор пишет изменённый JSON обратно и вызывает `ConfigRegistry.reload(partial)`,
что эмитит `config:reloaded` — модули перечитывают свои настройки без перезапуска игры.
