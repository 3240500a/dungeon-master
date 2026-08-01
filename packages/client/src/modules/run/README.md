# modules/run — UI забега v2 (карта + подписи узлов)

Клиентская обвязка генератора забегов v2. Данные приходят авторитетно с сервера кадром
`runPlan` (граф RunPlan + текущий узел) и складываются в `App.run`. Сам граф генерируется на
сервере (`server/net/room.ts` → `@dm/shared` `generateRunPlan`); клиент только рисует и шлёт выбор.

## Файлы
- `runLabels.ts` — единые русские подписи (`runNodeLabel`) и цвета (`runNodeColor`) типов узлов
  (start/combat/elite/boss/treasure/event/shop/rest/finale). Используются картой, миникартой и
  подписями выходов в `OnlineScene`/`online3d` — одна истина.
- `runMapPanel.ts` — DOM-панель «Карта забега» (клавиша **M**, регистрируется как `runmap` в
  `main.ts` и `render3d/online3d.ts`). SVG-граф: узлы по слоям (depth = столбец, lane = строка),
  рёбра-связи, текущий узел подсвечен, достижимые следующие (рёбра из текущего) выделены — «видно
  вперёд» как в Slay the Spire. Только информация: спуск делается физически у выхода (голосование).

## Контракт с сервером
- Кадр `runPlan {plan, currentNodeId}` → `App.run` (см. `core/app.ts`). Сбрасывается в городе.
- Выходы этажа (`FloorInit.exits[i]`) соответствуют рёбрам узла (`node.edges[i]`). Рендер выходов
  (2D `OnlineScene.buildArea`, 3D `online3d.buildArea`) шлёт `descend{targetNodeId: edges[i].to}`.
- Алтарь забега — `modules/town/difficultyPanel.ts` (биом/шаблон/модификаторы/тир → `descend{runConfig}`).

## Тесты
Логику жизненного цикла (старт → ветки → финал → город; контракт exits==edges; алтарь) покрывает
headless-E2E `server/src/net/room.run.test.ts`. Панель — чистый рендер из `App.run` (без своей математики).
