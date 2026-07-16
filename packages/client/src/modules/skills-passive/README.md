# Модуль: skills-passive (ДЕРЕВО МАСТЕРСТВА)

Общее большое **дерево мастерства** (одно на всех; бывшая «пассивка», конфиг `mastery-tree`).
**v4: ~332 узла, ВЕЕР артерий от каждого входа** — от 4 входов-атрибутов у центра (↑Сила ←Ловкость
→Живучесть ↓Интеллект) веером расходятся тематические АРТЕРИИ (18 всего). Каждая — линия с РОМБАМИ
(развилка на 2: ◄лево/►право дают РАЗНЫЕ статы → выбор пути), нотаблем и (сигнатурная) кейстоном.
Внутри веера соседние артерии сшиты ПЕРЕМЫЧКАМИ (маршрут под билд), соседние веера — ПЕРЕХОДАМИ в
зазорах. Бонусы — **только проценты** (без плоских атрибутов), малые; моды множатся на ранг. Прокачка
за ЗОЛОТО + 1 очко мастерства, **цена золота растёт с рангом** (`balance.passiveRankCostMult`), правило
смежности как в PoE. **Все входы доступны всем классам** (класс-гейт снят в Ф6). Сброс — `respecPassives`.
Визуальный граф-вью с пан/зумом. Генерируется `scripts/gen-passive.mjs`. Артерии/билды — в
[docs/CLASSES.md](../../../../../docs/CLASSES.md).

- **Контракт:** `allocatePassive(app, state, nodeId)` (золото + очко мастерства + смежность),
  `isAllocatable(tree, state, nodeId, allowedEntries?)` (вход ИЛИ сосед вложен),
  `neighborsOf(tree, nodeId)`, `passiveModifiers(config, allocation)` (модификатор×ранг),
  `renderPassiveTree(app, body)` — SVG-граф (узлы/рёбра, пан/зум, клик-прокачка).
- **Входы:** `passiveEntriesFor(reg, save)` (в `economy/townActions.ts`, реэкспорт из `@dm/shared`)
  возвращает ВСЕ `entryNodes` — класс-гейт убран, любой класс стартует с любого входа. Дальше — по
  смежности, включая переходы в край соседней ветви (гибриды).
- **Данные:** `mastery-tree.json` — `entryNodes`, `edges` (неориентированные), `nodes` (с `x,y,notable`).
  База генерируется `scripts/gen-passive.mjs`, правится в **граф-редакторе**
  (`packages/editor/src/passiveGraph.ts`, страница «Дерево мастерства»): ПКМ создать/удалить/связать,
  клик → правка (моды %/цена/ступени). Палитра %-статов — `passiveGraph.ts` (STAT_GROUPS).
- **Применение статов:** `passiveModifiers` подключается в `App` как `GameState.passiveModsProvider`
  и домешивается в `GameState.derived()` — новый узел влияет на статы без правки кода.
- **Сброс (`respecPassives`, серверно-авторитетно в `economy/townActions.ts`):** возвращает
  очки мастерства (Σ рангов, чистит осиротевшие узлы), **вложенное золото НЕ возвращает**; комиссия =
  `balance.passiveRespecCostPct` (доля вложенного золота, растёт с прокачкой). Кнопка — в шапке граф-вью
  (`treeView.ts`), cmd `respecPassives`.
- **Конфиг:** `mastery-tree` (`entryNodes`, `nodes` с `cost.type='gold'`); `balance.passiveRespecCostPct`,
  `balance.masteryPointsPerLevel` (очки/уровень).
- **Хранение:** `save.masteries` (nodeId→ранг), `save.unspentMasteryPoints`.
- **UI:** прокачивается ТОЛЬКО у Мастера прокачки — `passiveSection.ts` встроен во вкладку
  «Дерево мастерства» панели Мастера (`progression/panels.ts`). В окне «Скиллы» (K) мастерств нет.
- **Тесты:** `modules/skills/skills.test.ts` (за золото, смежность, статы),
  `economy/townActions.test.ts` (сброс + все входы открыты).
