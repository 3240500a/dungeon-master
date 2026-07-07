# Модуль: skills-passive

Общее большое пассивное дерево (одно на всех, ~105 узлов, 3 кластера, 4 кольца, нотабли
и кистоуны). Прокачка за ЗОЛОТО, **цена растёт с рангом** (`balance.passiveRankCostGrowth`),
правило смежности как в PoE. Визуальный граф-вью с пан/зумом. Генерируется gen-passive.mjs.

- **Контракт:** `allocatePassive(app, state, nodeId)` (золото + правило смежности),
  `isAllocatable(tree, state, nodeId)` (вход или сосед по ребру вложен),
  `neighborsOf(tree, nodeId)`, `passiveModifiers(config, allocation)` (модификатор×ранг),
  `renderPassiveTree(app, body)` — SVG-граф (узлы/рёбра, пан/зум, клик-прокачка).
- **Данные:** `skills-passive.json` — `entryNodes`, `edges` (неориентированные связи),
  `nodes` (с `x,y,notable`). Генерируется `scripts/gen-passive.mjs` (перегенерация — node).
- **Применение статов:** `passiveModifiers` подключается в `App` как
  `GameState.passiveModsProvider` и домешивается в `GameState.derived()` — новый узел с
  модификаторами влияет на статы без правки кода.
- **Конфиг:** `skills-passive` (`entryNodes`, `nodes` с `cost.type='gold'`).
- **Хранение:** `save.passiveSkills` (nodeId→ранг).
- **UI:** прокачивается ТОЛЬКО у Мастера прокачки — `passiveSection.ts` (`renderPassiveSection`)
  встроен во вкладку «Пассивное дерево» панели Мастера (`progression/panels.ts`). В окне
  «Скиллы» (K) пассивов нет. F6 заменит список визуальным граф-вью большого дерева.
- **Тесты:** `modules/skills/skills.test.ts` (прокачка за золото, влияние на maxHp).
