# MODULE_MAP.md — реестр модулей

Таблица связей для быстрой навигации при доработке. По любой задаче: найди строку модуля →
перейди в его папку/README → оттуда к конфигу, формулам и тестам этой части.

Статус: `план` (спроектирован) · `в работе` · `готово`.

| Модуль | Папка | Конфиг(и) | Слушает события | Шлёт события | Формулы | Тесты | Статус |
|---|---|---|---|---|---|---|---|
| core | client/src/core | — | — | — | stats | — | готово |
| events | shared/src/events | — | — | — | — | events.test.ts | готово |
| config | shared/src/config | data/*.json | config:reloaded | config:reloaded | — | registry.test.ts | готово |
| difficulty | shared/src/formulas/power.ts, client/src/modules/town/difficultyPanel.ts | difficulties, balance.power | — | run:enter | power (effectiveLevel, startChallenge, challengeAtFloor, isDifficultyUnlocked) | power.test.ts | Фаза 4 готово (выбор у портала + Мощь в C + тир/CL на HUD); калибровка — Фаза 3 |
| combat-math (shared) | shared/src/formulas/playerCombat.ts, skills.ts | balance | — | — | combatStatsOf, buildAttackPacket, attackByType, estimateAttack, damageMultOf (%-урон), passive/activeTreeModifiers | playerCombat.test.ts, world.test.ts (ailmentPct) | готово |
| world-core (shared) | shared/src/world | balance.collision/weight | — | — | debuffs (стаки), combat (resolvePlayerHit), grid/lineOfSight/movement/pathfind (сетка+стены+BFS, headless), separation (расталкивание сущностей по весу), state (WorldState + DashState) | world.test.ts, movement.test.ts, separation.test.ts | Этап 1 GameSession готов. Коллизии сущностей: сепарация по массе (вес монстра/игрока), отброс `knockback`×`shoveChance`, рывок-движение (`dashSpeed`×ранг + `dashWeightBonus`) |
| gear-derive (shared) | shared/src/formulas/resolveWeapon.ts, resolveArmor.ts | items.base | — | — | weaponDebuffs, weightScaleSplit, armorClassModifiers, armorNoise | resolveGear.test.ts | готово |
| session-core (shared) | shared/src/session | все (через ConfigRegistry) | — | SessionEvent | GameSession.tick (движение/ИИ/бой/скиллы/лут/XP/смерть), derive (playerSnapshot + рантайм-моды тоглов/баффов), ai (stepMonsterAi), bot (BotController), runner (runSessionSim), stats (RunReport/buildSnapshot) | session.test.ts, runner.test.ts | Этапы 2+4 готовы. **Skills v2:** активка дискриминирована по `category` (attack/cast/aura/stance/buff), единый диспетчер `castSkill`→`executeAbility` (легаси удалён). **attack** = удар оружием (`weaponAttack`+`meleeSwing`): геометрия/состав урона от оружия ×damageMult×ранг + эффекты, опц. `dash`; **cast** — стихийное по `shape`; **aura/stance** — тоглы (резерв/`buffMods`); **buff** — врем. моды. Гейт оружия у attack/cast: `weaponTypes`/`weaponClasses`/`hands`. Замах `windupSec`+прерывание; аффинити; сет-бонус; стих. статусы |
| dungeon-gen (shared) | shared/src/dungeon | dungeons, packs, monsters | — | — | generateDungeon (3-проходная), buildFloor (пачки→FloorLayout) | (через session.test) | headless-копия генератора этажа для сима/сервера; клиент пока держит свою (Этап 3 объединит) |
| sim | shared/src/sim, shared/src/session/runner; editor/src/sim.ts; server/src/sim-cli.ts | все конфиги (ConfigRegistry) | — | — | абстрактный: playerBot/economy/fight/floor/progression/run; настоящий: runSessionSim (бот на GameSession) | sim.test.ts, runner.test.ts | вкладка «Симулятор» (режим «Полный прогон (бот)» = d2planner-отчёт) + CLI `npm run sim -- --scenario=run`; калибровка — Фаза D |
| movement | client/src/modules/movement | balance | — | — | stats | — | готово |
| combat | client/src/modules/combat | items.base, balance, monsters, packs | — | monster:died, player:damaged, player:died | SessionController (драйвер headless GameSession), Monster/Projectile (виды) | shared/session/session.test.ts | Этап 3: авторитет боя — @dm/shared/session; клиент рисует. Игрок — Arcade-движение, зеркалится в сессию |
| dungeon-gen | client/src/modules/dungeon-gen | dungeons, difficulties, balance.power | — | floor:entered | реэкспорт @dm/shared generateDungeon; спавн пачек — shared spawnPacks | generate.test.ts | готово (генератор — общий в @dm/shared) |
| loot | client/src/modules/loot | items.base, affixes, uniques, dungeons, difficulties, item-tiers | monster:died | item:dropped, item:picked, gold:changed | itemgen (тир-масштаб базы по ilvl + MF/золото по сложности) | formulas.test.ts | готово |
| inventory | client/src/modules/inventory | items.base | item:picked | state:changed | stats | formulas.test.ts | готово |
| consumables | client/src/modules/consumables | items.base (kind=consumable, пояс beltSlots) | — | state:changed | — | consumables.test.ts | готово (зелья/колбы + D2-пояс, клавиши 1-4) |
| classes | client/src/modules/classes | classes | — | — | — | — | готово |
| skills (аллокация/статы) | client/src/modules/skills-active | skill-tree (единое древо: аллокация по смежности за очки скилла, класс-ветка по classId; статы актив+пассив-узлов) | — | state:changed | — | skills.test.ts | готово (Ф4-6) |
| mastery (дерево мастерства) | client/src/modules/skills-passive | mastery-tree | — | state:changed | stats | skills.test.ts, townActions.test.ts | готово (v4: ~332 узла, ВЕЕР артерий от 4 входов; **все входы доступны всем** (класс-гейт снят, Ф6); сброс `respecPassives`; editor/passiveGraph.ts) |
| skills (panel) | client/src/modules/skills | skill-tree | state:changed | state:changed, allocSkill/respecSkills (cmd) | — | skills.test.ts | готово (Ф5-7: РАДИАЛЬНОЕ единое древо `skillTreeView.ts` (пан/зум, квадраты), выносливость в HUD, сброс за золото `respecSkills`) |
| progression | client/src/modules/progression | balance, classes | monster:died | player:levelup, state:changed | xp, stats | formulas.test.ts | готово |
| town | client/src/modules/town | items.base, affixes, uniques, dungeons, balance (+ balance.stash) | ui:open | state:changed, gold:changed, stashOpen/stashMove (cmd) | itemgen, economy/stashActions | formulas.test.ts, stashActions.test.ts | готово (+ ОБЩИЙ сундук на аккаунт: 2 вкладки 20×12, кадр `stash`, БД `account_stash`) |
| quests | client/src/modules/quests (вью) + shared/economy/questLogic (авторитет) | quests.main, quests.random, items.base | — (трекинг на сервере) | log:message | questLogic | questLogic.test.ts | готово |
| death | client/src/modules/death | balance | player:died | state:changed | — | penalty.test.ts | готово |
| auth | client/src/modules/auth + server (users/sessions/characters) | classes (для create) | — | — (fetch `/api`) | newCharacterSave, password (scrypt) | password.test.ts, newCharacter.test.ts | готово |
| sfx | client/src/modules/sfx | — | monster:died, player:damaged, item:picked, gold:changed, player:levelup | — | — | — | готово |
| server | server/src | balance (xpTable) | WS join/cmd/…, HTTP auth | snapshot/events/saveUpdate/stash/… | saveStateSchema, newCharacterSave, questLogic, stashActions | password.test.ts | готово (+ таблица `account_stash`, `net/accountStash.ts`) |
| editor | editor/src | все схемы (shared) | — | (BroadcastChannel→config:reloaded) | — | form.test.ts | готово (граф-редакторы: mastery-tree — `passiveGraph.ts`, skill-tree — `skillGraph.ts` (+«Вид»: Общее/Класс) — пан/зум/драг, ПКМ создать/удалить/связать) |

> Обновляй эту таблицу при каждом изменении модуля (Definition of Done).
