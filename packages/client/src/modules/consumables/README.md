# Модуль: consumables

Расходники (зелья/колбы) + D2-пояс быстрых слотов.

- **Контракт:** `applyUse(app, item)` — применяет эффект зелья к `GameState`
  (hp/мана клампятся по `derived()`, `cure` снимает дебаффы, `buffMods` → временный
  `GameState.potionBuffs`); возвращает false, если эффекта нет (полное HP). `useBeltSlot(app, i)`
  — пьёт слот пояса, расходует и автопополняет из инвентаря. `useInventoryConsumable(app, item)`,
  `moveInventoryToBelt(app, item, i)`, `addConsumableToBelt`, `autofillBelt`, `beltCapacity`,
  `syncBeltLength`.
- **Данные:** `items.base` вид `kind:'consumable'` (`use{…}`, без слота); броня-пояс — поле
  `beltSlots`. Save: `belt: (Item|null)[]` (длина = beltSlots надетого пояса).
- **Сервер:** «В пояс» = команда `moveBelt` → `moveToBelt` (`shared/economy/townActions.ts`): первая свободная ячейка
  В ПРЕДЕЛАХ ёмкости (недостающие хвостовые — свободные, за ёмкостью — не место). ⚠ V-B2-01: сперва все проверки, сейв —
  только на успехе; раньше пояс добивался пустыми ячейками до проверок, и отказ («Предмет не в инвентаре», «Не расходник»,
  «Пояс полон») менял сейв. Тест — `shared/economy/economyFuzz.test.ts` («V-B2-01»).
- **Мана — до потолка с резервом аур (⚠ C-14):** `applyConsumable(…, manaCap)` наливает ману только до эффективного потолка
  (`effectivePool`): у потолка зелье маны «без эффекта» и не тратится (R4-35), выше не наливает. Сервер — `GameSession.drink`,
  один для пояса ввода и команды `useConsumable`; клиент — `state.effectiveMaxMana()`. Раньше сравнение шло с полным пулом:
  зелье у потолка ауры уходило, реген тика срезал ману, а каст того же тика тратил налитое сверх резерва. Тест —
  `shared/src/session/potionReserve.test.ts` (все расходники × пояс и команда, сидированный перебор).
- **UI:** HUD `ui/beltBar.ts` (слоты 1-4, клавиши/клик); ПКМ-меню зелья в `inventoryPanel`
  (Выпить / В пояс / Выбросить); магазин `shopPanel` всегда в продаже.
- **События:** нет своих; `commit` шлёт `state:changed` и пишет сейв.
- **Тесты:** `consumables.test.ts` (клампы heal/mana, cure, расход+автопополнение пояса).
