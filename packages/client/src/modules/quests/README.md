# Модуль: quests (клиент — чистый вью)

Квесты: основная цепочка + случайные с доски. **Авторитет — сервер** (анти-чит): вся логика
и награды в shared `economy/questLogic.ts`, трекинг — в серверном `Room` по событиям сессии.
Клиент только отображает и шлёт команды.

- **Логика (shared, чистая):** `economy/questLogic.ts` — `acceptQuest(save, def)`,
  `turnInQuest(reg, save, id)`, `trackObjective(save, 'kill'|'collect-item', target)`,
  `trackFloor(save, depth)`, `ensureMainQuest(reg, save)`, `generateBoard(reg, rng)`,
  `questFromTemplate(tpl, rng, uid)`, `questXp(level, xpTable, permille)`. Мутируют `save`.
- **Трекинг (сервер `Room`):** из событий сессии — `monster-died.by` (kill по `def.id`),
  `item-picked` (collect-item по `item.baseId`), `enterDungeon` (reach-floor по глубине,
  общий прогресс пати). Изменения шлются владельцу как `saveUpdate` + событие `quest`.
- **Основная цепочка:** `ensureMainQuest` при входе игрока/в город выдаёт `quests.main[0]`;
  при сдаче квеста с `next` следующий принимается автоматически (в `turnInQuest`).
- **Случайные:** доска `Room.questBoard` из `quests.random`, шлётся клиенту кадром
  `questBoard` (→ `app.questBoard`); «Взять» = команда `acceptQuest`.
- **Награды при сдаче:** золото/опыт-доля (через shared `gainXp`)/очки скиллов/предмет —
  считает `turnInQuest`, клиент шлёт `turnInQuest`, сервер отвечает `saveUpdate`.
- **Хранение:** `save.quests` (прогресс) + `save.activeQuestDefs` (резолвнутые определения).
- **Конфиг:** `quests.main`, `quests.random`, `items.base` (награды-предметы).
- **Протокол:** C→S команды `acceptQuest`/`turnInQuest`; S→C кадр `questBoard` + событие
  сессии `quest{kind:'accepted'|'completed'|'turned-in'}` (→ строка в личный лог).
- **UI:** `questLogPanel.ts` (клавиша J) — ЧИСТЫЙ ВЬЮ: активные/к сдаче из `save`, доска из
  `app.questBoard`; кнопки шлют команды. NPC «Доска квестов» в городе.
- **Тесты:** `shared/src/economy/questLogic.test.ts` (приём/трек/сдача+повтор/этаж/доска).
