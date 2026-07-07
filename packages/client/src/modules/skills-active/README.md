# Модуль: skills-active

Активные скиллы по классам: 3 ветки × ~10 узлов, ярусами (гейт по уровню персонажа
`levelReq` + prereq), ранги до 20. Смесь активных способностей и «мастерств»
(пассивные модификаторы за очки скиллов). Генерируется `scripts/gen-active.mjs`.

- **Контракт:** `activeTreeFor(config, classId)`, `allocateActive(config, state, nodeId)`
  (очки + `levelReq` + prereq + ранг; первое вложение уходит в хотбар), `bindHotbar(...)`,
  `activeModifiers(config, classId, allocation)` — модификаторы мастерств в статы
  (подключены в App как `GameState.activeModsProvider`). Ранг активок усиливает урон
  способности в бою (combatController).
- **Каст:** исполняется боевым контроллером (модуль combat): ПКМ = слот 1, клавиши 1–4.
  Мана/кулдаун берутся из `node.effect.active`; combat читает `skills-active` из конфига.
- **Конфиг:** `skills-active` (по классам: branches[], nodes[] с `cost.type='points'`).
- **Хранение:** `save.activeSkills` (nodeId→ранг), `save.hotbar` (слот→nodeId).
- **UI:** вкладка «Активные» в `modules/skills/skillsPanel.ts` (клавиша K).
- **Тесты:** `modules/skills/skills.test.ts`.
