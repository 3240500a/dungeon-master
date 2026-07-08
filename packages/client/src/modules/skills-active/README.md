# Модуль: skills-active

Активные скиллы по классам: 3 ветки × ~10 узлов, ярусами (гейт по уровню персонажа
`levelReq` + prereq), ранги до 20. Смесь активных способностей и «мастерств»
(пассивные модификаторы за очки скиллов). Генерируется `scripts/gen-active.mjs`.

- **Контракт:** `activeTreeFor(config, classId)`, `allocateActive(config, state, nodeId)`
  (очки + `levelReq` + prereq + ранг; первое вложение уходит в хотбар), `bindHotbar(...)`,
  `activeModifiers(config, classId, allocation)` — модификаторы мастерств в статы
  (подключены в App как `GameState.activeModsProvider`). Ранг активок усиливает урон
  способности в бою (combatController).
- **Каст:** авторитетно на сервере (`GameSession.castSkill`); клиент шлёт ввод. ПКМ = слот 1, клавиши 1–4.
- **Модель скилла (v2):** `node.effect.active` дискриминирована по **`category`**: `attack` (удар оружием —
  геометрия/состав урона от оружия ×damageMult, + эффекты; опц. `dash`), `cast` (стихийное по `shape`:
  projectile/boomerang/nova/ground/meteor/curse), `aura`/`stance` (тоглы: резерв маны + `buffMods`), `buff`
  (врем. моды на `durationSec`). Ограничения оружия у attack/cast: `weaponTypes`/`weaponClasses`/`hands`
  (пусто → любое). Пассив-мастерства — `effect.modifiers`. Движок — `shared/session/session.ts`.
- **Конфиг:** `skills-active` (по классам: branches[], nodes[] с `cost.type='points'`); схема — `discriminatedUnion('category')`.
- **Хранение:** `save.activeSkills` (nodeId→ранг), `save.hotbar` (слот→nodeId).
- **UI:** вкладка «Активные» в `modules/skills/skillsPanel.ts` (клавиша K).
- **Тесты:** `modules/skills/skills.test.ts`.
