# Модуль: skills-passive

Общее большое пассивное дерево (одно на всех). **v4: ~332 узла, ВЕЕР артерий от каждого входа** — от
4 входов-атрибутов у центра (↑Сила ←Ловкость →Живучесть ↓Интеллект) веером расходятся несколько
тематических АРТЕРИЙ (18 всего). Каждая — линия с РОМБАМИ (развилка на 2: ◄лево/►право дают РАЗНЫЕ
статы → выбор пути), нотаблем и (сигнатурная) кейстоном. Внутри веера соседние артерии сшиты
ПЕРЕМЫЧКАМИ (маршрут под билд), соседние веера — ПЕРЕХОДАМИ в зазорах (3 на стык, для гибридов).
Бонусы — **только проценты** (без плоских атрибутов), малые; моды множатся на ранг. Прокачка за ЗОЛОТО,
**цена растёт с рангом** (`balance.passiveRankCostMult`), правило смежности как в PoE. **Гейт входов
по классу** (см. ниже) + **сброс** `respecPassives`. Визуальный граф-вью с пан/зумом. Генерируется
`scripts/gen-passive.mjs` (артерии/темы декларативно в `ARTERIES`/`T`). Артерии и билды классов — в
[docs/CLASSES.md](../../../../../docs/CLASSES.md).

- **Контракт:** `allocatePassive(app, state, nodeId)` (золото + смежность + гейт входа),
  `isAllocatable(tree, state, nodeId, allowedEntries?)` (вход из набора класса или сосед вложен),
  `neighborsOf(tree, nodeId)`, `passiveModifiers(config, allocation)` (модификатор×ранг),
  `renderPassiveTree(app, body)` — SVG-граф (узлы/рёбра, пан/зум, клик-прокачка; чужие входы — красно-серые).
- **Гейт входов по классу:** `class.passiveEntries` (2 id) — с них класс начинает; пусто = все входы.
  `passiveEntriesFor(reg, save)` (в `economy/townActions.ts`, реэкспорт из `@dm/shared`) — доступные входы;
  гейтит `townActions.allocPassive` (сервер) и клиентский `allocate.isAllocatable`. Остальное — по смежности,
  включая переходы в край соседней ветви (гибриды дотягиваются, не имея входа соседа).
- **Данные:** `skills-passive.json` — `entryNodes`, `edges` (неориентированные связи),
  `nodes` (с `x,y,notable`). База генерируется `scripts/gen-passive.mjs` (перегенерация — node),
  далее правится мышью в **граф-редакторе** (`packages/editor/src/passiveGraph.ts`): ПКМ по
  пустому → создать узел (малый/крупный), клик → правка (моды %/цена/ступени), ПКМ по узлу →
  удалить / добавить связь. Палитра %-статов v2 — см. `passiveGraph.ts` (STAT_GROUPS).
- **Применение статов:** `passiveModifiers` подключается в `App` как
  `GameState.passiveModsProvider` и домешивается в `GameState.derived()` — новый узел с
  модификаторами влияет на статы без правки кода.
- **Сброс (`respecPassives`, серверно-авторитетно в `economy/townActions.ts`):** возвращает
  очки пассивов (Σ рангов, заодно чистит осиротевшие после регена дерева узлы), **вложенное в узлы
  золото НЕ возвращает**; комиссия = `balance.passiveRespecCostPct` (доля вложенного золота, растёт
  с прокачкой — `passiveRespecFee`/`passiveInvestedGold`). Кнопка — в шапке граф-вью (`treeView.ts`),
  cmd `respecPassives`. Тест — `economy/townActions.test.ts`.
- **Конфиг:** `skills-passive` (`entryNodes`, `nodes` с `cost.type='gold'`); `balance.passiveRespecCostPct`.
- **Хранение:** `save.passiveSkills` (nodeId→ранг).
- **UI:** прокачивается ТОЛЬКО у Мастера прокачки — `passiveSection.ts` (`renderPassiveSection`)
  встроен во вкладку «Пассивное дерево» панели Мастера (`progression/panels.ts`). В окне
  «Скиллы» (K) пассивов нет.
- **Тесты:** `modules/skills/skills.test.ts` (прокачка за золото, смежность, влияние на статы),
  `economy/townActions.test.ts` (сброс: возврат очков, комиссия, невозврат золота). %-статы
  урона/статусов — `shared/formulas/playerCombat.test.ts` + `shared/world/world.test.ts`.
