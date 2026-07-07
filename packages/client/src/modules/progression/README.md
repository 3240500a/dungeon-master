# Модуль: progression (клиент — вью + команды)

Опыт, уровни и распределение очков атрибутов. **Авторитет — сервер** (анти-чит): XP/левелапы
и распределение считает сервер; клиент отображает `save` и шлёт команды.

- **XP/левелап (сервер):** shared `economy/progression.ts` → `gainXp(save, balance, amount)` —
  ЕДИНАЯ истина прокачки, используется и боевой наградой сессии (`GameSession.awardXp`), и
  сдачей квеста (`turnInQuest`). Клиент показывает событие `levelup`/`xp` из сессии (лог+звук).
- **Распределение (команды):** `panels.ts` шлёт `allocAttr`/`respec` серверу (`townActions`
  `allocAttr`/`respec`); клиент отображает серверный `saveUpdate`, локально ничего не мутирует.
  - `characterPanel` (клавиша C): **полный лист персонажа (D2-стайл)** — шапка, Атрибуты (+),
    Наступление (урон/скор. атаки/крит/меткость), Защита (броня/блок/HP/мана/реген),
    Сопротивления, Прочее. `masterPanel` (NPC мастер) — «Пассивное дерево» и «Атрибуты»(+респек).
  - Производные статы (`@dm/shared` DerivedStats): accuracy, blockChance, hpRegen, manaRegen,
    resFire/Cold/Lightning/Poison. Реген HP/маны тикает в серверной `GameSession`.
- **Конфиг:** `balance` (xpTable, attributePointsPerLevel, skillPointsPerLevel,
  passivePointsPerLevel, respecCost), `classes` (база атрибутов для респека).
- **Формулы:** `levelForXp`, `xpForLevel` (`@dm/shared/formulas/xp`); `gainXp`
  (`@dm/shared/economy/progression`).
- **Тесты:** XP-таблица — `shared/formulas.test.ts`; начисление/сдача — `questLogic.test.ts`.
