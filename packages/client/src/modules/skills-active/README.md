# Модуль: skills-active (аллокация/статы древа скилов)

Клиентская обёртка над **ЕДИНЫМ древом скилов** (`skill-tree`) — актив И пассив узлы в 32 ветках
(1руч/2руч/дальнобой/дуал/жезл-посох, стихии, проклятья, ауры, стойки, броня×3, щит + сигнатурная
ветка класса). Классового деления активок больше нет (Ф4-6): дерево общее для всех, ветки класса
гейтятся по `classId`. Панель/рендер — в `modules/skills` (радиальный граф). Данные генерируются
`scripts/gen-skill-tree.mjs`.

- **Контракт:** `activeTreeFor(config)` → `skill-tree`; `allocateActive(config, state, nodeId)`
  (очки скилла + `levelReq` + **смежность** от входа ветки + класс-гейт по `classId`; первое вложение
  активного узла уходит в хотбар), `bindHotbar(...)`. Статы пассив-узлов — `activeStats.ts`
  `activeModifiers(config, allocation)` (= `skillTreeModifiers`, подключён в App как провайдер и
  домешивается в `GameState.derived()`).
- **Ресурс:** боевые активки тратят **выносливость**, магические — **ману**; ауры резервируют ману,
  стойки — выносливость (`active.resource`; движок — `shared/session/session.ts`).
- **Каст:** авторитетно на сервере (`GameSession.castSkill`); клиент шлёт ввод. ПКМ = слот 1, клавиши 1–4.
- **Модель узла:** `node.effect.active` дискриминирована по **`category`** (attack/cast/curse/aura/stance/
  buff); пассив-узел — `effect.modifiers` (%-стат ветки). Гейт оружия/рук — из ветки
  (`weaponClasses`/`weaponType`/`hands`/`requiresDual`), штампуется на способность.
- **Конфиг:** `skill-tree` (branches[] с group/resource/classId?/гейт; nodes[] `kind` active/passive,
  `cost.type='points'`, `x,y,notable`).
- **Хранение:** `save.skills` (nodeId→ранг), `save.hotbar` (слот→nodeId).
- **UI/сброс:** панель K — `modules/skills/skillTreeView.ts` (радиальный граф); сброс за золото
  `respecSkills` (комиссия `balance.skillRespecCostPerPoint`×вложенные очки).
- **Тесты:** `modules/skills/skills.test.ts` (смежность, класс-гейт, хотбар),
  `economy/townActions.test.ts` (`allocActive`/`respecSkills`).
