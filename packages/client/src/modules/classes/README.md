# Модуль: classes

Стартовые классы (Воин/Маг/Лучник): доступ к определениям.

- **Контракт:** `listClasses(config)`, `findClass(config, id)`.
- **Стартовый набор** (оружие класса + базовая броня) строит shared
  `newCharacterSave(reg, classId, name, charId)` — ЕДИНЫЙ авторитетный билдер для клиента и
  сервера (см. модуль `save`). Клиентского `startingItems` больше нет (дубль убран).
- **Конфиг:** `classes` (см. data/classes.json). Стартовые атрибуты, стартовое оружие,
  id активного дерева, спрайт, аффинити, **`derived`** — масштаб пулов HP/маны класса
  (`hpBase/hpPerVitality/hpPerLevel`, `manaBase/manaPerIntelligence/manaPerLevel`; формула в
  `shared/formulas/stats.ts` `deriveStats`, тип `HpManaScaling`). Правится в редакторе.
- **События:** нет (используется сценой ClassSelect напрямую при старте новой игры).
- **Важно:** класс задаёт только стартовые атрибуты и активное дерево. Базовая атака
  зависит от типа надетого оружия (модуль combat, M4), а не от класса.
- **UI:** `scenes/ClassSelectScene.ts` — карточки классов, старт новой игры/continue.
