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
  ⚠ R8-12: модификаторы — только действующие (`altarModifiers`; эффекты `run-modifiers` пока не подключены — секции нет),
  сервер и план берут выбор одним правилом `pickRunModifiers` (без дублей, благо — в паре с опасностью). ⚠ R10-15: узловые
  (★ на карте) — тем же правилом: недействующий модификатор узлу не вешается, и ★ нет, пока эффект не подключён (бросок
  узла прежний — граф забега из сейва тот же).
- ⭐ R8-10: `FloorInit.challengeLevel`/`difficultyId` — уровень заселения узла и тир для строки «вызов ур.» HUD.
- ⭐ R9-08: голосование за спуск из города (`voteStart`) несёт то, что начнётся: `difficultyId`, `templateId`, `biomeId`,
  `modifiers` и `resume{host, depth}` (продолжение чьего забега). Текст окна — `ui/voteText.ts` (`voteQuestion`, одна истина
  для `OnlineScene` и `online3d`), закрытый своему герою тир — «вам ещё не открыта». Сменилось, пока голосовали, — сервер
  отменяет (`voteEnd{passed:false}` + `error{code:'vote'}`). Тест — `ui/voteText.test.ts`.

## Тесты
Логику жизненного цикла (старт → ветки → финал → город; контракт exits==edges; алтарь) покрывает
headless-E2E `server/src/net/room.run.test.ts`. Панель — чистый рендер из `App.run` (без своей математики).
