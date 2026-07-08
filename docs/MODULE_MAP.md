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
| combat-math (shared) | shared/src/formulas/playerCombat.ts, skills.ts | balance | — | — | combatStatsOf, buildAttackPacket, attackByType, estimateAttack, passive/activeTreeModifiers | (через playerStats/skills-*) | готово |
| world-core (shared) | shared/src/world | — | — | — | debuffs (движок стаков), combat (resolvePlayerHit), grid/lineOfSight/movement/pathfind (сеточное движение+коллизии+BFS, headless), state (модель WorldState) | world.test.ts, movement.test.ts | Этап 1 GameSession готов; план — docs/GAMESESSION.md |
| gear-derive (shared) | shared/src/formulas/resolveWeapon.ts, resolveArmor.ts | items.base | — | — | weaponDebuffs, weightScaleSplit, armorClassModifiers, armorNoise | resolveGear.test.ts | готово |
| session-core (shared) | shared/src/session | все (через ConfigRegistry) | — | SessionEvent | GameSession.tick (движение/ИИ/бой/скиллы/лут/XP/смерть), derive (playerSnapshot + рантайм-моды тоглов/баффов), ai (stepMonsterAi), bot (BotController), runner (runSessionSim), stats (RunReport/buildSnapshot) | session.test.ts, runner.test.ts | Этапы 2+4 готовы. **Движок скиллов (фазы A-D):** `active.type` (strike/cleave/nova/projectile/boomerang/dash/curse/toggle/buff) без КД — скорость от attackSpeed×`speed`; замах `windupSec`+прерывание (`interruptResist`); тоглы/ауры (резерв маны, эксклюзив, `buffMods`); аффинити фракций; сет-бонус брони; наложение стих. статусов скиллом |
| dungeon-gen (shared) | shared/src/dungeon | dungeons, packs, monsters | — | — | generateDungeon (3-проходная), buildFloor (пачки→FloorLayout) | (через session.test) | headless-копия генератора этажа для сима/сервера; клиент пока держит свою (Этап 3 объединит) |
| sim | shared/src/sim, shared/src/session/runner; editor/src/sim.ts; server/src/sim-cli.ts | все конфиги (ConfigRegistry) | — | — | абстрактный: playerBot/economy/fight/floor/progression/run; настоящий: runSessionSim (бот на GameSession) | sim.test.ts, runner.test.ts | вкладка «Симулятор» (режим «Полный прогон (бот)» = d2planner-отчёт) + CLI `npm run sim -- --scenario=run`; калибровка — Фаза D |
| movement | client/src/modules/movement | balance | — | — | stats | — | готово |
| combat | client/src/modules/combat | items.base, balance, monsters, packs | — | monster:died, player:damaged, player:died | SessionController (драйвер headless GameSession), Monster/Projectile (виды) | shared/session/session.test.ts | Этап 3: авторитет боя — @dm/shared/session; клиент рисует. Игрок — Arcade-движение, зеркалится в сессию |
| dungeon-gen | client/src/modules/dungeon-gen | dungeons, difficulties, balance.power | — | floor:entered | реэкспорт @dm/shared generateDungeon; спавн пачек — shared spawnPacks | generate.test.ts | готово (генератор — общий в @dm/shared) |
| loot | client/src/modules/loot | items.base, affixes, uniques, dungeons, difficulties, item-tiers | monster:died | item:dropped, item:picked, gold:changed | itemgen (тир-масштаб базы по ilvl + MF/золото по сложности) | formulas.test.ts | готово |
| inventory | client/src/modules/inventory | items.base | item:picked | state:changed | stats | formulas.test.ts | готово |
| consumables | client/src/modules/consumables | items.base (kind=consumable, пояс beltSlots) | — | state:changed | — | consumables.test.ts | готово (зелья/колбы + D2-пояс, клавиши 1-4) |
| classes | client/src/modules/classes | classes | — | — | — | — | готово |
| skills-active | client/src/modules/skills-active | skills-active | — | state:changed | — | skills.test.ts | готово |
| skills-passive | client/src/modules/skills-passive | skills-passive | — | state:changed | stats | skills.test.ts | готово |
| skills (panel) | client/src/modules/skills | skills-active, skills-passive | state:changed | state:changed | — | skills.test.ts | готово |
| progression | client/src/modules/progression | balance, classes | monster:died | player:levelup, state:changed | xp, stats | formulas.test.ts | готово |
| town | client/src/modules/town | items.base, affixes, uniques, dungeons, balance (+ balance.stash) | ui:open | state:changed, gold:changed, stashOpen/stashMove (cmd) | itemgen, economy/stashActions | formulas.test.ts, stashActions.test.ts | готово (+ ОБЩИЙ сундук на аккаунт: 2 вкладки 20×12, кадр `stash`, БД `account_stash`) |
| quests | client/src/modules/quests (вью) + shared/economy/questLogic (авторитет) | quests.main, quests.random, items.base | — (трекинг на сервере) | log:message | questLogic | questLogic.test.ts | готово |
| death | client/src/modules/death | balance | player:died | state:changed | — | penalty.test.ts | готово |
| auth | client/src/modules/auth + server (users/sessions/characters) | classes (для create) | — | — (fetch `/api`) | newCharacterSave, password (scrypt) | password.test.ts, newCharacter.test.ts | готово |
| sfx | client/src/modules/sfx | — | monster:died, player:damaged, item:picked, gold:changed, player:levelup | — | — | — | готово |
| server | server/src | balance (xpTable) | WS join/cmd/…, HTTP auth | snapshot/events/saveUpdate/stash/… | saveStateSchema, newCharacterSave, questLogic, stashActions | password.test.ts | готово (+ таблица `account_stash`, `net/accountStash.ts`) |
| editor | editor/src | все схемы (shared) | — | (BroadcastChannel→config:reloaded) | — | form.test.ts | готово |

> Обновляй эту таблицу при каждом изменении модуля (Definition of Done).
