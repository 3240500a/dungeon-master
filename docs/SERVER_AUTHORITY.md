# SERVER_AUTHORITY.md — что авторитетно на сервере (реестр портов client→server)

**Зачем этот файл.** Игра стала полностью серверно-авторитетной (см. [MULTIPLAYER.md](MULTIPLAYER.md)).
При переносе механик с клиента на сервер НЕСКОЛЬКО РАЗ терялась логика (награды, квесты, **смерть**,
кузница). Этот файл — единый реестр: что где живёт, что уже авторитетно, что ещё нет. **Правило:
портируешь клиентскую механику на сервер — обнови строку здесь и пройди чек-лист внизу.**

Принцип: **клиент = вью+ввод**. Любое изменение `SaveState`/мира считает СЕРВЕР (`GameSession` в
`packages/shared/src/session` + `packages/server/src/net/room.ts`), клиент только шлёт ввод/команды и
рисует снапшоты. Чистая логика — в `packages/shared` (переиспользуют сервер и сим).

## Реестр механик

| Механика | Логика (shared) | Оркестрация (server) | Статус | Заметки |
|---|---|---|---|---|
| Движение/коллизии | `world/movement.ts` (стены), `world/separation.ts` (расталкивание по весу), `session.ts` | Room.step → tick | ✅ | клиент — чистый вид. **Сущности расталкиваются по массе-весу** (монстр `monsters.weight`×чемпион-мульт; игрок `playerWeight` от брони/щита/оружия) — единое правило «кто тяжелее, тот толкает»; конфиг `balance.collision`+`balance.weight`. **Отброс скиллов**: `knockback`×`shoveChance` (масштаб весом цели). **Рывок** — движение (не телепорт): `dashSpeed`×ранг + `dashWeightBonus` (тяжёлый в рывке плужит сквозь пачку) |
| Бой/скиллы/снаряды | `formulas/combat`, `world/combat`, `session.ts` | tick | ✅ | **Skills v2:** активка дискриминирована по `category` (attack/cast/aura/stance/buff), единый диспетчер `castSkill`→`executeAbility` (легаси-путь удалён). **attack** = удар ОРУЖИЕМ (`weaponAttack`+обобщённый `meleeSwing`): геометрия (дальность/размах/цели) и СОСТАВ урона — от оружия ×damageMult×ранг, скилл добавляет эффекты; `dash` — гэпклоузер (урон в коридоре вдоль траектории, **полу-ширина = размах удара** `swingHalfWidth(range,arc)` — общая формула с клиентским VFX). **cast** — стихийное по `shape`. Гейт оружия у attack/cast: `weaponTypes`/`weaponClasses`/`hands`. **VFX-вид** (`playerVfx`): форма удара показывается ТОЛЬКО в момент удара (сектор/для рывка — полоса), цвет по стихии, для всех биндов (attack+cast) — клиент-предсказание темпа, логику боя не трогает |
| Монстры (ИИ/спавн/скейл) | `formulas/monstergen`, `dungeon/floor spawnPacks`, `session.ts` | enterDungeon | ✅ | стат-блок скейлится `balance.monsterScaling` |
| Награды (золото/опыт/дроп/левелап) | `session.ts killMonster/awardXp`, `economy/progression gainXp`, `formulas/itemgen pickDropBase` | tick→saveUpdate | ✅ | **дроп data-driven:** `balance.loot.dropChance` + `categoryWeights` (доля категории независимо от числа баз) × per-item `dropWeight`. Колбы дропаются (normal), щиты — по весу; магазин — те же веса с `consumable:0`. Убран хардкод 0.55 и мёртвый `dropTableId` |
| Подбор/сброс лута | `session.ts pickup/dropToGround` | cmd `pickup`/`drop` | ✅ | |
| Экономика (магазин/экип/распределение/бинды/пояс) | `economy/townActions.ts` | Room.handleCmd (`buy/sell/equip/unequip/allocAttr/respec/allocPassive/allocSkill/moveBelt/bind/useConsumable/drop`) | ✅ | клиент НЕ мутирует save |
| **Раскладка инвентаря (item.pos)** | `economy/townActions.moveInventoryItem` → `inventory/grid.placeWithDisplacement`; лечение на загрузке `packInventory` (`roomManager.sanitize`) | Room.handleCmd (`moveItem`) → `sendSave` | ✅ | **авторитетна на сервере**: клиент шлёт `moveItem`, рисует `saveUpdate`; держимый предмет — визуальный, сейв не мутирует. Убраны хардкод-костыли: грефтинг позиций в `netDriver.applySave`, self-heal `packInventory` в панели, мёртвый `equip.ts`. Чинит «переставил→подобрал→сбросилось/нет места». Проверено live (move/swap/reconnect) |
| **Общий сундук (shared stash)** | `economy/stashActions.ts` (`stashMove/sanitizeStash`) → `inventory/grid`; тип `types/stash.AccountStash` | `server/db account_stash`, `net/accountStash.ts` (load/save), `Room.handleCmd` (`stashOpen/stashMove`) → кадр `stash` + `sendSave` | ✅ | **на уровне АККАУНТА** (не в `SaveState`): один сундук на всех героев пользователя — перенос шмота между персонажами. БД — единая истина (node:sqlite синхронна → операция атомарна; last-writer-wins). Размер — `balance.stash {tabs,cols,rows}` (деф. 2 вкладки × 20×12 = 4 инвентаря/вкладку). Курсор общий с инвентарём (`inventory/heldItem.ts`). `SaveState.stash` — ЛЕГАСИ (не используется). Штраф смерти сундук не трогает (он вне save). Caveat: два героя аккаунта онлайн у сундука → пуш только активному, второй увидит при переоткрытии |
| Квесты (трек/приём/сдача) | `economy/questLogic.ts` | Room (события tick + cmd `acceptQuest/turnInQuest`, кадр `questBoard`) | ✅ | |
| Двери/рычаги подземелья | `dungeon/generate.ts`, `session.ts openLever` | Room.pullLever, кадр `doorOpened` | ✅ | инвариант проходимости |
| Сложность (выбор/прогресс) | `formulas/power isDifficultyUnlocked`, `session world.difficultyId` | Room.descend/enterDungeon | ✅ | |
| Аккаунты/сейвы | `economy/newCharacter`, `validation/save`, `formulas/xp` | `server/db`, HTTP + WS join (владение) | ✅ | **Персист прогресса:** `Room.persistAll` → `putCharacter`. Пишется на входе/выходе, **автосейв каждые 10с** (`AUTOSAVE_MS`), на чекпойнтах (город/смена этажа/левелап) и на graceful shutdown (`RoomManager.flushAll` по SIGINT/SIGTERM). Раньше писалось ТОЛЬКО на join/leave → рестарт/краш терял весь забег (персонаж откатывался к 1 ур.) |
| Реконнект + вход по намерению | `session.addPlayer(spawnAt)`, `economy/death` | `Room.removePlayer`→грейс (**только из подземелья**), `Room.reconnect`, `Room.abandonAsDead`/`destroyIfEmpty`, `RoomManager` (`runStatus`/`join{resume\|fresh\|roomCode}`/`abandon`, `graceByChar`), `expireGrace`/`finalizeDisconnectedAsDead` | ✅ | **Грейс — ТОЛЬКО из подземелья** (в городе выход = чистый разрыв, пустая комната уничтожается сразу). Реконнект НИКОГДА не перехватывает осознанный вход: `runStatus`→модалка «Продолжить/Забросить»; `join{resume}`→в грейс, `{fresh}`/`{roomCode}`→новая/к другу. **Анти-эксплойт:** осознанный вход в новую комнату при висящем забеге = `abandonAsDead` (штраф смерти, порядок: штраф в БД → чтение урезанного сейва), чтобы дисконнектом не «банковать» лут без риска. Пусто-в-данже→пауза+`reconnectGraceSec`(1ч)→все погибли; пати-вайп→отключённые тоже. Раньше грейс висел час после ЛЮБОГО выхода и глотал вход по коду («кидало в разные комнаты») — [MULTIPLAYER.md](MULTIPLAYER.md#лобби-и-реконнект-по-намерению--сделано-июль-2026) |
| **Смерть (штраф + возрождение)** | `economy/death.ts applyDeathPenalty`, `session.respawnPlayer`, `session.enterFloor` (оживляет мёртвых) | Room.onPlayerDeath, кадр `died` | ✅ | детали ниже |
| Кузница (forge) | — | — | ⛔ **НЕ ПОРТИРОВАНА** | `client/modules/town/forgePanel.ts` правит предметы локально без cmd → сервер откатывает. TODO: cmd `forgeUpgrade/forgeReroll` в townActions |
| Туман войны | `world/lineOfSight` | — (клиент-вью) | ✅ | чисто отрисовка, сервер не нужен |
| Конфиг игры (редактор ↔ игра) | `config/registry.ts reload/snapshot` | `GET /api/config` (читают клиент+редактор), `POST /api/dev/config`+`DELETE /api/dev/config/:key` (dev-only) → SQLite `config_overrides` → `rebuildConfig` | ✅ | **единая серверная истина**: дефолты (data/*.json) + персистентные оверрайды (переживают рестарт). Клиент/редактор грузят эффективный конфиг с сервера (localStorage выпилен). balance сразу; статы монстров/лут — со след. этажа. Запись гейтится `NODE_ENV!=='production'` (анти-чит) |

## Смерть — полная спецификация (не терять снова)

Порт клиентского `death/penalty.ts` (был завязан на удалённую `DungeonScene`). Сейчас:
1. **Штраф** (`economy/death.ts applyDeathPenalty(save, balance.deathPenalty)`): теряется
   `goldPercent` золота + первые `inventoryDropPercent`·len предметов инвентаря. **Экипировка,
   стеш, пояс СОХРАНЯЮТСЯ.** hp не трогается. Возвращает `{goldLost, itemsLost}` для окна.
2. **Событие** сессии `player-died` (в `session.tick`, обе ветки урона: DoT L238 и удар монстра L717)
   → `Room.onPlayerDeath`: применяет штраф, шлёт погибшему кадр `died{goldLost,itemsLost,toTown}`,
   `saveUpdate` с урезанным сейвом.
3. **Возрождение:**
   - **Вайп пати** (все игроки мертвы; соло = вайп на 1 игрока) → `Room.wipeAt = now+4000` → через ~4с
     в `step()` → `enterTown()`. Задержка ВАЖНА: мгновенный `enterTown` шлёт `areaChanged` тем же тиком и
     закрыл бы окно смерти, не показав его. `enterFloor` оживляет мёртвых (`respawnPlayer` = спавн, полное
     HP/мана, сброс дебаффов/тоглов, `alive=true`). `enterTown/enterDungeon` сбрасывают `wipeAt`.
   - **Кооп без вайпа** (кто-то ещё жив) → погибший ЖДЁТ мёртвым (спектейт). Когда пати спускается на
     след. этаж (голосование → `enterDungeon` → `enterFloor`), **мёртвые оживают на новом этаже**.
4. **Клиент** (`OnlineScene`): кадр `died` → модалка «Вы погибли» с потерями и статусом (`toTown` → «возврат
   в город…»; кооп → «ждите пати» + кнопка «Смотреть»). Закрывается на `areaChanged` (= возрождение).
   NB: `renderGrid` теперь возвращает `objects[]` (все тайлы) — `buildArea` кладёт их в `worldObjs` и рушит
   при пересборке; иначе тайлы старой области ТЕКЛИ под новую (город после смерти рисовался поверх данжа).
5. **Конфиг:** `balance.deathPenalty { goldPercent, inventoryDropPercent }`.

Ограничение архитектуры: комната = ОДНА `GameSession` (один этаж). Поэтому в коопе нельзя отправить
одного игрока в город, пока другие в данже → мёртвый ждёт на этаже. Индивидуальный «corpse-run в город»
потребовал бы мульти-сессий на комнату (вне объёма).

## Чек-лист: как портировать клиентскую механику на сервер (чтобы НЕ потерять логику)

1. Найти клиентскую реализацию (обычно `client/src/modules/<x>` или контроллер сцены). **Прочитать
   ВСЮ логику**, включая побочные эффекты (потеря лута, сброс глубины, экраны, звук).
2. Вынести ЧИСТУЮ логику в `packages/shared` (над `SaveState`/миром, без Phaser/DOM), с тестом.
3. Оркестрация на сервере: `Room` (команда/событие tick) применяет её и шлёт `saveUpdate`/кадр.
4. Протокол: добавить `ClientFrame`/`ServerFrame`/`TownCommand` в `shared/session/netTypes.ts`.
5. Клиент: заменить локальную мутацию на `app.sendCmd(...)`/`net.send(...)`; UI рисует ответ сервера.
6. **Удалить** мёртвую клиентскую копию (модуль/контроллер), обновить строку в этом файле + README модуля.
7. Verify: typecheck×4 + vitest + build; ручной кросс-тест в 2 вкладках.
