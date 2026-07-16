# CONFIG_SCHEMA.md — конфиги игры

Все конфиги живут в `packages/shared/src/config/data/*.json` и валидируются zod-схемами из
`packages/shared/src/config/schemas.ts`. Игра и HTML-редактор используют одни и те же схемы.

| Ключ | Файл | Назначение | Основные поля |
|---|---|---|---|
| balance | data/balance.json | глобальный баланс | xpTable (кап ~90), pointsPerLevel, masteryPointsPerLevel, deathPenalty, weaponAttrScaling, forgePrices, respecCost, passiveRespecCostPct (комиссия сброса мастерства = доля вложенного золота), **skillRespecCostPerPoint** (комиссия сброса скилов = золото за вложенное очко), inventory(cols,rows), autoPickup[], passiveRankCostMult |
| classes | data/classes.json | стартовые классы (архетипы) | id, name, startAttributes, startWeaponId, sprite, affinity[], derived (per-класс масштаб HP/маны/выносливости от атрибутов) |
| items.base | data/items-base.json | базы предметов | id, slot (incl. belt), weaponType?, baseStats, requirements, itemLevel, gridW, gridH |
| affixes | data/affixes.json | префиксы/суффиксы | id, kind, stat, tiers[min,max,ilvl] |
| uniques | data/uniques.json | уникальные предметы | id, baseId, fixedAffixes |
| monsters | data/monsters.json | монстры | id, name, hp, minDamage, maxDamage, damageType, attackSpeed, armor, accuracy, evade, blockChance, critChance, res*, xp, ai, sprite, vision* |
| monster-affixes | data/monster-affixes.json | аффиксы монстров | id, name, mult{}, add{}, damageType? (огненный/быстрый/бронированный/…) |
| packs | data/packs.json | пачки монстров по типам комнат | roomType, min, max, champion |
| dungeons | data/dungeons.json | темы подземелий | id, tileset, monsterPool, dropBias, modifiers |
| skill-tree | data/skill-tree.json | ЕДИНОЕ древо скилов (актив+пассив, для всех) | branches[] (group/resource/classId?/weapon-gate/entryNode), nodes[] (kind active/passive, branchId, x/y), edges[], entryNodes[] |
| mastery-tree | data/mastery-tree.json | дерево мастерства (общие %-пассивы) | nodes[], edges[], entryNodes[] |
| quests.main | data/quests-main.json | сюжетные цепочки | id, steps[], objectives[], rewards |
| quests.random | data/quests-random.json | шаблоны случайных квестов | id, objectiveType, ranges, rewardPool |

## Стоимость узлов скиллов
Общий формат `SkillNode.cost = { type: 'points' | 'gold', amount }`.
- **Древо скилов (`skill-tree`)** — узлы (актив И пассив) за **очки скилла** (`points`), по смежности от
  входа ветки; сброс за золото (`respecSkills`, комиссия `skillRespecCostPerPoint`×очки).
- **Дерево мастерства (`mastery-tree`)** — узлы за **золото** (`gold`, геом. рост ×`passiveRankCostMult`) +
  1 очко мастерства; сброс за золото (`respecPassives`). Все входы доступны всем классам.

## Требования оружия (weaponType → атрибут)
`melee → Strength`, `ranged → Dexterity`, `magic → Intelligence`. Масштаб урона от
атрибута задаётся в `balance.weaponAttrScaling`. Требования конкретной базы — в
`items.base[].requirements`.

## Live-apply
HTML-редактор пишет изменённый JSON обратно и вызывает `ConfigRegistry.reload(partial)`,
что эмитит `config:reloaded` — модули перечитывают свои настройки без перезапуска игры.
