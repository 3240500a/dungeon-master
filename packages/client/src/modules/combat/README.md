# Модуль: combat

## Авторитет — headless `GameSession` (Этап 3 миграции)
Вся боевая логика (движение монстров, ИИ, разрешение боя, снаряды, дебаффы, смерть)
теперь в `@dm/shared/session` (`GameSession.tick`) — тот же код, что гоняет симулятор.
Клиент только **кормит сессию вводом и рисует** её состояние.

- **Драйвер (сцена-владелец):** `SessionController` (`sessionController.ts`) — держит
  `GameSession` в режиме `rewards:false`, каждый кадр: зеркалит позицию/HP/ману/дебаффы
  Arcade-игрока в сущность сессии, собирает ввод (ЛКМ — атака, ПКМ/Shift/Space/Alt —
  слоты 0..3), `tick(dt)`, зеркалит обратно, рисует монстров/снаряды/числа урона.
  `update(dt)`, `monsterCount`, `destroy()`.
- **Движение игрока** — прежняя Arcade-физика (`movement/player.ts`); позиция зеркалится
  в сессию (сессия игрока не двигает). Монстры/снаряды двигает сессия (сеточная коллизия).
- **Виды:** `Monster` (`monster.ts`) — только отрисовка: `sync(entity)` + `drawStatus()`
  (имя/HP-бар/дебаффы/значок агро/стана) + `flash()`. `Projectile` (`projectile.ts`) —
  спрайт, позицию задаёт драйвер из `world.projectiles`.
- **Лут/XP/золото/квесты — по-старому через шину:** сессия эмитит `monster-died`, драйвер
  транслирует в `monster:died` → LootController/Progression/quests/sfx (без задвоения).
  Также шлёт `player:damaged`, `player:died`.
- **Расчёт урона/статов/ИИ/снарядов/дебаффов:** `@dm/shared` (`resolvePlayerHit`,
  `resolveAttack`, `stepMonsterAi`, `playerSnapshot`, `weaponDebuffs`, `monsterDebuffs`…).
- **Статусы удара по СОСТАВУ пакета** (базовая атака + атака/каст-скиллы): `mergeElementOnHit`
  (`resolveWeapon.ts`) — физ-статус подтипа (`weaponDebuffs`) держится лишь при наличии физ. урона,
  плюс авто стих-проки по каждой стихии в ударе (`elementDebuffs`, таблица `magic-subtypes.weapon`).
  Скилл может конвертить долю урона в стихию (`convertPct`+`element`, у attack и cast) — при полной
  конверсии физ-статус гаснет, остаётся статус стихии; явный `ailment` скилла переопределяет авто того
  же вида. Тюнится в редакторе (schemas: `magicSubtypesSchema.weapon`, `attackAbilitySchema.convertPct`).
- **Форма урона скилла** (`shapeSkillPacket` в `resolveWeapon.ts`) — 3 режима, поля в редакторе:
  `multScope` (`base` — множитель только на баз. тип оружия, стихии гира не раздуваются / `all` — весь пакет),
  `addElementPct` (добавить % базового урона как `element` сверх состава), `convertPct` (слить долю в `element`).
  Статусы всегда следуют итоговому составу пакета (physSub при физ. уроне + по стихии на каждый присутствующий
  тип). Панель (`panels.ts` `skillByType`) считает разбивку урона и статусы скилла по тому же конвейеру.
- **Состояния (дебаффы) — data-driven:** конфиг `debuffs` (имя/иконка/категория/описание + тюн-коэффициенты).
  `debuffMods(state, tuning)` берёт интринсик-коэффициенты (пороги/факторы) из конфига с фолбэком на дефолты;
  `debuffLabel/debuffIcon(cfg, kind)` — подписи/иконки из конфига (фолбэк — константы `DEBUFF_LABEL/ICON`).
  Правится в редакторе: «⚔ Боевая система → Состояния».
- **Стат-пакеты для панелей:** `playerStats.ts` (тонкие обёртки над `@dm/shared/playerCombat`).
- **Конфиг:** `items.base`, `balance.weaponAttrScaling`, `monsters`, `packs`, `difficulties`.
- **Тесты:** ядро боя — `shared/src/session/session.test.ts`; поведение в игре — руками.
- **Использование:** `scenes/DungeonScene.ts` (генерация этажа — `@dm/shared` `generateDungeon`
  + `spawnPacks`).
