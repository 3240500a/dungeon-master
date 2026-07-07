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
- **Стат-пакеты для панелей:** `playerStats.ts` (тонкие обёртки над `@dm/shared/playerCombat`).
- **Конфиг:** `items.base`, `balance.weaponAttrScaling`, `monsters`, `packs`, `difficulties`.
- **Тесты:** ядро боя — `shared/src/session/session.test.ts`; поведение в игре — руками.
- **Использование:** `scenes/DungeonScene.ts` (генерация этажа — `@dm/shared` `generateDungeon`
  + `spawnPacks`).
