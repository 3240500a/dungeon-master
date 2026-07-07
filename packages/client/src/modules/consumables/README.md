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
- **UI:** HUD `ui/beltBar.ts` (слоты 1-4, клавиши/клик); ПКМ-меню зелья в `inventoryPanel`
  (Выпить / В пояс / Выбросить); магазин `shopPanel` всегда в продаже.
- **События:** нет своих; `commit` шлёт `state:changed` и пишет сейв.
- **Тесты:** `consumables.test.ts` (клампы heal/mana, cure, расход+автопополнение пояса).
