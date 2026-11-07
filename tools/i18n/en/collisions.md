# Столкновения английских терминов — глоссарий v0 (07.11.2026)

Источник решений: `glossary_draft.json` в этой же папке. В заметках записей есть пометка «КОЛЛИЗИЯ».
Ограничения взяты из `locales.json → en.strings`: 629 строк, всё, что уже переведено, считается занятым.
Проверка была двойной. Скрипт `collide.py` нашёл одинаковые EN у разных RU, остальное я разбирал руками.

## 0. Уже решено владельцем (не трогаю)

| RU | EN | почему |
|---|---|---|
| Заступник (класс) | **Warden** | слово занято классом |
| печать «Сторожевой» | Watchful | вместо Warden |
| эпитет «стража» | Sentinel | вместо Warden |
| этаж «Чертог стражей» | Hall of Guardians | вместо Warden |

Проверено: в глоссарии нет ни одного EN со словами Warden, Huntress, Wolfhound, Spellbinder, Blizzard,
Diviner, Marksman, Hunter, Sentinel, Watchful или Guardians.

## 1. Новый термин хотел уже занятое слово, развёл

| RU (новое) | хотело | занято кем | решение | владельцу? |
|---|---|---|---|---|
| Сила (пассив булав, +физ. урон) | Strength | атрибут Сила → Strength | **Brawn** | да |
| Ловкость (пассив лёгкой брони, +уклонение) | Dexterity / Agility | атрибут Ловкость → Dexterity | **Deftness** | да |
| Ловчий (стойка) | Hunter | класс Ловчая → Huntress | **Stalker** | да |
| Раскол (пассив топора) | Rift | rare-noun «Раскол» → Rift | **Splitting** | да |
| Разлом (активка 2-руч топора) | Rift | биом «Разлом» → The Rift Gates | **Fracture** | да |
| Секира (активка axe-cleave) | Axe | «секира» в вещах → Axe (War Axe, Executioner's Axe) | **Cleave** | да |
| Гроза (активка, нотабль мастерства) | Storm | rare-noun «Гроза» → Storm, «Буря» → Storm Staff | **Thunderstorm** | да |
| Смертельный … (7 узлов) | Deadly | аффикс «Смертоносный» → Deadly | **Lethal …**; идиомы: Deathblow, Dance of Death, Wheel of Death | нет |
| Сокрушающий удар / взмах, Сокрушение | Crushing | подтип «Дробящий» → Crushing | **Shatter-** (Shattering Blow/Sweep, Shatter); «Дроб-» остаётся за Crush | да |
| Рассечение / Рассекающий удар | Cleaving | подтип «Рубящий» → Cleaving, плюс «Секира» → Cleave | **Riving / Riving Blow** (rive = рассечь; ср. Riven Ash) | да (нотабль) |
| Секущие раны | Slashing Wounds | подтип «Режущий» → Slashing | **Rending Cuts** | нет |
| Широкий взмах | Wide Swing | вставка «Широкий размах» → Wide Swing | **Broad Sweep** | нет |
| Серия уколов | Flurry | вставка «Череда» → Flurry | **Rapid Stabs** | нет |
| Шквал (клинков / зарядов / нотабль) | Flurry | «Череда» → Flurry | **Squall** (Blade Squall, Squall of Bolts, Squall) | да |
| Лёгкая поступь | Light Step | вставка «Лёгкий шаг» → Light Step | **Light Tread** | нет |
| Поджог (пассив огня) | Burn | дебафф «Поджиг» → Burn | **Arson** | нет |
| Пробивающий выпад | Punch-Through | вставка «Пробойник» → Punch-Through | **Driving Lunge** | нет |
| Проникновение | Penetration | узел «Пробой» → Penetration | **Permeation** | нет |
| Хват (пассив 2-руч) | Grip | rare-noun / узел «Хватка» → Grip | **Firm Grip**; тег анатомии «Хват» → **Hold** | нет |
| Кольца (пассив кольчуги) | Rings | salvage «Кольца» (украшения) → Rings | **Riveted Rings** | нет |
| Жилистость | Sinew | материал «Сырая жила» → Raw Sinew | **Wiry Frame** | нет |
| Прицел | Aim | monster-item «меткости» → of Aim | **Sighting** | нет |
| Меткий выстрел | Marksman's Shot | класс Free Marksman | **Unerring Shot** (как monster-affix «Меткий» → Unerring) | нет |
| Крепость (+здоровье) | Fortitude / Toughness / Sturdiness | эпитет «стойкости» → Fortitude, run-mod → Toughness, ступень → Sturdy | **Constitution** | нет |
| Выносливость (пассив, 12 узлов) | Stamina | подпись стата maxStamina | **Endurance** (заодно не путается с печатью Enduring) | да |
| Мощь тела | Brawn | «Сила» булав → Brawn | **Mighty Frame** | нет |
| Мощь стихии (пассив) | Elemental Might | ветка «Стихийная мощь» → Elemental Might | **Elemental Power** | нет |
| Заряд (пассив молнии) | Charge | «Рывок» → Charge | **Static** | нет |
| Неистовый удар | Frenzied Blow | Frenzy есть у «Ярость (комната)»; печать «Яростные» → Furious | **Frenzied Blow** оставлен: прилагательное, а не имя модификатора | да (нотабль) |
| Богатырский удар / обвал | Champion's … | ранг монстров «Чемпионы» → Champions | **Titan's Blow / Titan's Avalanche** (alt Bogatyr's) | да |
| Кара небес / Небесная кара (в RU почти тёзки) | одно слово на обе | — | **Judgment of Heaven** и **Heavenly Smite**: Кара → Judgment (так же Кара Света → Judgment of Light, Кара гнили → Judgment of Rot), а «Небесная кара» → Smite | да |
| Молния (скил) | Lightning | ветка «Молния» → Lightning | **Lightning Bolt** | нет |
| Слабость (curse) | Weakness | соседний «Проклятие слабости» → Curse of Weakness | **Weaken** | нет |
| Сосредоточение | Concentration | «Концентрация» → Concentration | **Focus** | нет |
| ★ Несокрушимый (кейстон) | Unbreakable | нотабль/пассив «Несокрушимость» → Unbreakable | **★ Indomitable** | да |
| ★ Берсерк | Berserker | «Зомби-берсерк» → Zombie Berserker | **★ Berserk** (= стойка «Берсерк») | да |
| Моргенштерн (древковое «кропило», тип) | Morning Star | items.base «Моргенштерн» (1-руч) → Morning Star | **Holy Water Sprinkler** (alt Morning Star) | да |
| Самострел (тип арбалета) | Crossbow | base «Арбалет» → Crossbow; monster-gear «Ржавый самострел» → Rusted Crossbow | **Samostrel** (alt Stirrup Crossbow) | да |
| Скрамасакс (кинжал) | Seax | тип меча «Сакс» → Seax | **Scramasax** | нет |
| Меч долгой рукояти | Bastard / Hand-and-a-Half Sword | base «Полуторный меч» → Bastard Sword | **Long-Hilted Sword** | да |
| Ратный меч | Greatsword | monster-gear «Двуручный меч павшего» → Greatsword of the Fallen | **War Sword** (sword of war, Окшотт XIIIa) | нет |
| Навершие у жезла/посоха | Pommel | «Навершие» меча → Pommel | **Finial** (жезл, посох) / **Pommel** (меч) | нет |
| Оправа (жезл/посох) | Mount | тег «Крепление» → Mount | **Setting** | нет |
| Ствол жезла | Shaft | «Древко» → Shaft | **Rod** | нет |
| массивный / тяжёлый (детали) | Heavy | вес «Тяжёлое» → Heavy | массивный → **Massive** (как вес «Массивное»), тяжёлый → Heavy | нет |
| облегчённый / лёгкий (детали) | Light | вес «Лёгкое» → Light | облегчённый → **Lightened**, лёгкий → Light | нет |
| Пламенеющий (клинок, дага, двуручник) | Flaming | аффикс «Пламенный» → Flaming, вставка Flaming Edge | **Flamboyant** (термин волнистого клинка); у двуручника-типа — **Flamberge** | да (тип) |
| Порча (ветка Ворожеи) | Blight / Hex | «Посох гнили» → Blight Staff; «Зомби-ведун» → Zombie Hexer | **Hexcraft**; Hex — корень для «Скорая порча» → Swift Hex. Hexer у зомби — отдельное слово, допустимо | да |
| Ворожба (пассив) | Witchery | — | **Divination**, корень класса Ворожея → Diviner | нет |

## 2. Два русских слова дают одно английское (слияние принято сознательно)

| EN | RU | почему можно |
|---|---|---|
| Blade | Клинок (меч/кинжал), Полотно (топор/алебарда), rare-noun «Клинок» | это слоты разных классов, рядом на экране не стоят; Bit игроку непонятен |
| Grip | Рукоять (меч, булава, лук), Черен (кинжал), узел и rare-noun «Хватка» | слот анатомии и словечко из имени рара не встречаются в одном контексте. Если владелец против, alt для слота — Hilt/Handle |
| Pommel | Навершие (меч), Оголовок (кинжал) | одно и то же |
| Head | Било (булава), Перо (копьё) | разные классы, обе — «голова» оружия |
| Eye | Проушина (топор), rare-epithet «ока» | eye — стандартный термин анатомии топора; домены не пересекаются |
| Hook | значение «крюк» (булава), скил «Зацеп» | разные домены |
| Poleaxe | «Полэкс» (тип/анатомия), base «Секира на древке» | один и тот же предмет |
| Composite Bow | «Сложный лук» (тип), base «Составной лук» | один и тот же предмет |
| Long Bow | «Длинный лук» (тип), base long-bow | одно и то же |
| tang / on a Tang | «на хвостовике» (меч), «на черешке» (копьё) | оба значат tang |
| Banding | узел щита «Оковка», слот посоха «Оковка», значение «оковка» (булава) | одно RU, как «Окованный сундук» → Banded Chest |
| Charge | одиночный «Рывок» и составные «Копейный натиск» / «Натиск щитом» | одиночный «Натиск» остаётся Onslaught (как печать и эпитет); стихийные «X рывок» → X Dash |
| Fortitude | узел «Стойкость», эпитет «стойкости» | одно RU |
| Fire / Cold / Storm / Poison Warding | пассивы «Огнестойкость…», аффиксы «Пламегашения…» | один смысл, корень Warding из en |
| Precision | узел «Точность», аффикс «Меткости» → of Precision | оба дают меткость |
| Arcane | «Волшебные снаряды» → Arcane Missiles, вес «Волшебное», аффикс «Чародейский» | в en Arcane уже стоит у двух RU, я лишь продолжил |
| arming / bastard / two-handed / short | класс клинка в анатомии, «вилки» balance | одни и те же 4 класса, в en они уже есть |

## 3. Несогласованности, которые уже есть в en.strings (нашёл попутно; решать владельцу, я не правил)

1. **Стойкость**: эпитет «стойкости» → Fortitude, а monster-item «стойкости» → of Resilience; печать «Стойкие» → Enduring; run-mod «Стойкость (комната)» → Toughness. Для узлов взял Fortitude.
2. **Крепкий**: ступень t2 → Sturdy, а аффикс «Крепкий» → Stout.
3. **Иней**: rare-noun → Rime, вставка → Hoarfrost. Узел-вставка, понятно, Hoarfrost.
4. **Разряд**: rare-noun → Jolt, вставка «Дуговой разряд» → Arc Discharge. Узлы взяли Discharge.
5. **Печать**: rare-noun → Seal (как печати алтаря), тип вставки → Sigil. Разведено осознанно, оставить.
6. **Гниль / тлен**: rare-noun «Гниль» → Rot, «Посох гнили» → Blight Staff, «Посох тлена» → Staff of Rot. Для «Кара гнили» взял Rot.
7. **Стужа**: rare-noun → Chill, уник «Вечной стужи» → Eternal Frost, подфракция «культ стужи» → frost cult. Для узла взял Chill.
8. **Гроза / Буря**: обе → Storm (rare-noun «Гроза», Storm Staff, «культ грозы» → storm cult). Поэтому скил «Гроза» → Thunderstorm.
9. **Меткость**: стат → Accuracy (в коде), аффикс → of Precision, monster-affix «Меткий» → Unerring, monster-item «меткости» → of Aim.
10. **Ярость**: rare-noun → Fury, run-mod «Ярость (комната)» → Frenzy, monster-item «ярости» → of Fury.
11. **Раскол / Разлом**: обе → Rift (rare-noun «Раскол», биом «Разлом»).
12. **Живучесть / жизнь**: «Реликвия жизни» → Relic of Vitality, хотя «жизни» → Life (эпитет).
13. **Normal**: сложность «Средняя» и редкость «Обычный» обе → Normal. Для D2 норма, но это коллизия.
14. **Plated**: «Обшитый» и monster-item «Латный» обе → Plated.
15. **Орфография**: en в основном US (Armor, Vigor), но «Mouldered Hood/Shroud» — UK. Я везде брал US (Saber, Scepter). Нужна одна политика.
16. **Длинный меч**: base long-sword → Long Sword, а вилка «длинный» → arming. В английском longsword значит полуторный, поэтому вилка arming верна, а base Long Sword может сбивать знатоков.

## 4. Правила, которые из этого следуют (держать в следующих партиях)

- Одно RU-слово → одно EN во всех таблицах. Исключение — смысл расходится: тогда КОЛЛИЗИЯ записывается сюда.
- Корни: Мощь → Might, Сила (не атрибут) → Power (у магии — Force), Смертельный → Lethal, Сокруш- → Shatter, Дроб- → Crush, Рубить → Hew, Рассекать → Rive, Выпад → Lunge, Вихрь → Whirlwind (шаблон «<X> Whirlwind»), Кара → Judgment, Шквал → Squall, Ледян- → Ice, Морозн- → Frost, Ядовит- → Venom, Волшебн- → Arcane, Дыхание → Breath.
- Стат-лексика (подписи `srv:stat.*` ещё не переведены, но узлы уже на неё опираются): Здоровье → Life, Стойкость к прерыв. → Interrupt Resistance, Наложение статусов → Ailment Infliction, Шанс/Множ. крита → Critical Chance/Multiplier, Скор. атаки/каста/движения → Attack/Cast/Movement Speed, Сопр. X → X Resistance, Реген → Regeneration, Пробой брони → Armor Penetration. Сленг (крит, реген, каст) в EN не переносится.
- Эпохи мира: Archaic → Early → Classical → Imperial Age. «Ранний / Классический меч» → Early / Classical Sword. Исторические «Каролингский / Романский» остаются в alts: RU их тоже сознательно не называет.
- Номера типов: кириллическое «А» → латинское A (IVA, VIIIA, VA); «тип N» → «Type N».


---

# Редактура v1 (07.11.2026): `glossary_draft.json` → `glossary_final.json`

Вторая проверка, со стороны. Правил 69 записей: у каждой поле `changed` с причиной. Записей по-прежнему 1078.
Владельцу вынесено 43 решения вместо 55: 16 снято как мелочь или производное, 4 добавлено.

## 5. Полнота (имена из данных извлёк заново и сверил)

- Все 32 ветки, 455 узлов древа (309 разных имён), 332 узла мастерства (58 имён), 132 правила типов, 4 запасных существительных и «Свод» покрыты, и все их `ids` на месте.
- Анатомия: покрыто 565 из 565 строк корпуса (name, label, adj, epoch, with, name2h). Детали: 311 из 311, каждая подходит под одно из правил P1–P5 или есть в словаре.
- `skills-active.json` (57 имён вне древа) не переводится: файл мёртвый, удалить его уже стоит в roadmap (m6-16).
- Не в глоссарии, переводятся позже фразами: subtitle типов (123), caption деталей (31), lore (159), description узлов. Это предложения, а не имена.

## 6. Новые правила корней (держать дальше)

| RU | EN | пример | почему |
|---|---|---|---|
| размах | **Swing** | Wide Swing (вставка, уже в en), Full Swing, Lethal Swing, Hewing Swing | размах задан вставкой «Широкий размах» → Wide Swing |
| взмах | **Sweep** | Broad Sweep, Shattering Sweep, Precise Sweep | черновик путал Swing и Sweep в обе стороны |
| удар (физический, оружием) | **Blow** | Shattering/Heavy/Stunning/Wounding Blow | Strike оставляем для магии, святого и грома (Force/Righteous/Thunder Strike) и для идиом (Cross Strike, ★ Perfect Strike, Shield Bash, Deathblow) |
| скорый | **Quick** | Quick Hand (вставка, уже в en), Quick Hex | быстрый → Swift (аффикс «Быстрый» → Swift) |
| Огненн- | **Fire** | Fireball, Fire Trap, Fire Dash, Fire Enchantment | Пламен- → Flame/Flaming (Flame Burst, Flaming Edge) |
| Ледян- | **Ice**, без исключений | Ice Bolt, Ice Nova, Ice Dash, Touch of Ice | Icy Touch — имя заклинания WoW |
| укол | **Thrust** | Precise Thrust, Thrusting Power, Rapid Thrusts | |
| Удлинён- / Укорочен- | **Elongated / Shortened** | Elongated Triangular (III), Elongated Spindle, Shortened Shaft | |
| живуч- (если узел не даёт атрибут) | **Hardy / Hardiness** | нотабль «Живучесть» → Hardiness | как monster-affix «Живучий» → Hardy |
| Мастерство по типу урона | **Mastery: <тип>** | Mastery: Physical / Fire / Lightning | короче и как Fire/Lightning Mastery в D2; остальные — «Mastery: <стат>» |
| стат «скор. каста» | **Cast Speed** везде | узел «Скорость каста» тоже | у черновика было Casting Speed |
| чары (бафф) | **Enchantment** | Fire Enchantment | Charm в D2 — класс предметов; эпитет раров «чар» → Charms остаётся |

Единое правило для узлов с именем атрибута: если узел не даёт сам атрибут, EN-имя не равно имени атрибута. Отсюда Сила → Brawn,
Ловкость → Deftness и теперь Живучесть (нотабль мастерства, +здоровье и реген) → Hardiness. Эти три решения владелец принимает вместе.

## 7. Регистр (P6 уточнено)

- Запасные существительные меча: «двуручный меч / гладиус / полуторный меч / меч» → **Two-Handed Sword / Gladius / Bastard Sword / Sword**.
  Они встают внутрь имени `{adj} {noun} {epoch} {with}`, а `capitalize: first` поднимает только первую букву. В строчном виде вышло бы «Broad Short sword of the Imperial Age».
- Значения формы била булавы (18 шт.: Ball Mace, Bec de Corbin, Holy Water Sprinkler…) пишутся **с заглавных**. Шаблон `{strike.form.name} {bind.mount.with}`
  ставит их в начало имени. Строка-формула «Codex: head Ball Mace · …» с заглавными тоже читается, а наоборот («Ball mace with Langets») — нет.
- Остальные значения тегов и label остаются строчными. Сверено по `craftType.ts`: формула пишет «label value», label берётся строчным.

## 8. Историческая точность (поправлено)

- «4 концевые» накладки гуннского лука → **ear laths** (у Coulston и др. «ear laths / grip laths»). Деталь → «Siyahs, 4 Ear Laths».
- «бразильский орех» → **“Brazil nut”**: имя собственное с заглавной, как у Окшотта (Brazil-nut pommel).
- Архиерейский посох → **Prelate's Crosier**: crosier — основная US-форма, crozier — британская (см. политику орфографии).
- adj «удлинённо-треугольный» → **Triangular**. Он встаёт в «{adj} Spear/Pike/Lance», а «Elongated Spear» читается как «длинное копьё».
- Проверено и оставлено: Seax / Scramasax, Spatha, Xiphos, Akinakes, Kopis, Khopesh, Zweihander, Claymore, Messer (+ Nagel), Falchion, Flamberge (так у D2),
  Main-Gauche, Rondel / Ballock / Ear / Quillon Dagger, Baselard, Bauernwehr, Dane Axe, Bearded Axe, Lucerne Hammer, Bec de Corbin / de Faucon, Goedendag,
  Holy Water Sprinkler, Corseque, Spetum, Vouge, Glaive, Bill, Bardiche, Poleaxe, Self Bow, Gastraphetes, Cranequin, Windlass, Goat's-Foot, Stonebow, Slurbow,
  Balestrino, Schnepper, Lituus, Tau Staff. Коды Окшотта со строчной буквой (XIIIa, XIIIb, XVa) — верно. Типы Кирпичникова пишутся латинской заглавной (IVA, VIIIA).

## 9. Тон

- Поджог → **Scorch** (было Arson: уголовное слово, в D2-тоне режет слух).
- Огненные чары → **Fire Enchantment** (было Fire Charm, совпадает с классом предметов D2).
- «ганджа» (кинжал крис) → вынесено владельцу. Термин верный, но по-английски ganja — прежде всего марихуана, и «Kris with a Ganja» читается как шутка.
  Запасной вариант — яванское gonjo.
- Оставлено, хотя есть оттенок: Electrify (глагол у пассива, в фэнтези норма), Empowerment, Permeation, Rapid Fire — сленгом это не считается.

## 10. Длина (> 22 символов на кнопке древа)

Укоротил: Mastery: Physical Damage (24) → Mastery: Physical, Mastery: Lightning Damage (25) → Mastery: Lightning,
Mastery: Ailment Infliction (27) → Mastery: Ailments, а Mastery: Fire Damage → Mastery: Fire для единообразия.
**Длинными остались** (сверить с UI): Mastery: Critical Multiplier (28), Mastery: Critical Chance (24). Без сленга crit
короче не выходит; на крайний случай alt — Mastery: Lethality. Малые узлы Interrupt Resistance 2.5% (25) и Lightning Resistance 2% (23) не длиннее RU.
Типы оружия длиннее 22 символов (German Hunting Crossbow, Ring-Mounted Early Halberd) — это имена вещей, а не кнопки.

## 11. Принятые коллизии (ещё раз, осознанно)

- **Bolt** — и болт арбалета (Heavy/Bodkin/Lethal Bolt, Bolt Volley), и магический заряд жезла (Magic Bolt, Potent Bolt, Squall of Bolts). В ARPG это норма (Ice Bolt, Fire Bolt в D2).
  Ветки не пересекаются. Если будет мешать, менять жезловой заряд, а не болт; слово Missile не подходит — занято Arcane Missiles.
- **Порча брони → Corrode Armor** — исключение из «Порча → Hex». Здесь «порча» в прямом смысле, «повреждение», а не колдовство.
- **Натиск**: одиночный → Onslaught, в составе (Копейный натиск, Натиск щитом) → Charge, как в черновике.
- **Магический крит → Arcane Precision**: Магическ- → Magic (Magic Bolt, урон Magical), но здесь оставлено Arcane, потому что «Magic Precision» не по-английски.
- **Triangular**: значение навершия «треугольное» и adj пера «удлинённо-треугольный» стоят в разных слотах и рядом не встречаются.
- Alts, которые сами были заняты, заменены: Ловчий (Hunter's Stance противоречил решению), Сила (Might), Натиск (Charge), Стихийная мощь (Elemental Power), Скрамасакс (Seax), Казнящий удар (Execution).

## 12. Ещё одна несогласованность в en.strings (к разделу 3)

17. **Скорость движения**: run-mod «Скорость хода монстров» → «Monster move speed», а стат в глоссарии — **Movement Speed** (норма для ARPG). Предлагаю поправить run-mod на «Monster movement speed».

## 13. Список владельца: что изменилось

- **Снято 16**: Пронзающий меч, Казнящий удар, Неистовый удар, Шквал зарядов (производное от «Шквал»), ★ Перегрузка, ★ Идеальный удар, ★ Берсерк,
  Тяжёлая длань, Кара Света (покрыта парой «Кара небес» / «Небесная кара»), Ранний меч (покрыт сеткой эпох), Чекан IA и Рогатина с перекладиной (покрыты политикой транслита),
  Клык-оберег. Попутно сняты Огненный рывок (стал Fire Dash по корню), Скорая порча (стала Quick Hex) и шаблон «Mastery: <стат>» — они не вкусовые.
- **Добавлено 4**: Сабля (одно решение на всю орфографию US/UK), Живучесть → Hardiness (вместе с Brawn/Deftness), ганджа (тон),
  Ромбическое (II) (Rhombic против устоявшихся diamond-/lozenge-section).
- В запись «Рогатина» сведена политика транслита славянского оружия: Rogatina, Sulitsa, Shestopyor, Oslop, Chekan, Samostrel.
- В запись «имперской эпохи» сведена вся сетка эпох вместе с Early/Classical Sword. Отдельно отмечено, что «of the Early Age» звучит шероховато.


---

# Ревью Ф3 (07.11.2026): три полосы перевода → один голос

Скрипт свёл все короткие строки (≤ 4 слов) трёх полос, 629 прежних строк `en` и глоссарий: RU с разным EN — 80. Почти все — законно
разные смыслы (атрибут «Сила» → Strength и узел → Power; стат «Выносливость» → Stamina и узел → Endurance; имя узла «Сопр. огню» → Fire
Resistance и подпись стата → Fire Res.; «Войти» → Enter / Join / Log In по месту). Ниже — что пришлось решать.

## 14. Разведено или сведено на ревью

| RU | варианты полос | решение | почему |
|---|---|---|---|
| держит удар (подписи деталей, `srv:blade.balanceHand`) | braces blows better (C) / steadier under blows (B) | **steadier under blows** | одна фраза в окне ковки, у B — 18 подписей |
| удар крупнее / мельче (эффект детали) | bigger blows (C) / bigger hits (B) | **hits** | это урон одного попадания; Blow остаётся корнем ИМЁН умений (§6) |
| грань (подтип урона базы: режущий/колющий/дробящий/стихия) | edge (C) / damage type (B) | **damage type** | «edge» у жезла и булавы читается как лезвие |
| эталон (ноль оси детали, ширина эталона клинка) | reference (C) / baseline (B) | **baseline** | одно понятие оси |
| общий сундук (аккаунта) | shared chest (`cfg:floors/*-rest`, прежние) / Shared Stash (C) | **stash** | правило ядра: городской сундук → stash, сундук подземелья → chest |
| Логин / Ник (одно поле входа) | Login / Nickname | **Username** | поле одно; «Login» по-английски — действие |
| гнездо | socket (гнёзда умений и алтаря отрезка) / slot (гнездо детали оружия: `srv:forge.partWrongSocket`) | разведено | у детали это слот анатомии, а не гнездо вставки |

## 15. Принятые коллизии (новые)

- **Socket**: втулка копья/алебарды/булавы (анатомия, глоссарий) и гнездо вставки умения / печати на алтаре. Окна разные, рядом не стоят.
- **Morning Star**: значение анатомии и деталь «моргенштерн» (полоса B) = утверждённое владельцем имя типа; совпадает с 1-руч базой
  `items.base` «Моргенштерн». Глоссарий анатомии давал Holy Water Sprinkler — сведено к имени типа, чтобы деталь, формула и тип совпадали.
- **Trade**: обмен сырья (вкладка «⇄ Обмен») → Trade / traded везде: «Exchange» длиннее вкладки источника.
- **Trainer**: «Мастер прокачки» — не Master, чтобы не путался с Mastery.
- **«+5% to Fire Damage»** (подписи `srv:stat.*Pct`) и **«+5 Fire Damage»** (плоские `srv:stat.add*`): «to» держит их врозь; в описаниях узлов
  древа — «+5% Fire Damage per rank», как в источнике. Вопрос владельцу: Grim Dawn пишет оба без «to».

## 16. Не решить без правки глоссария (сторож держит)

- Глоссарий против своих политик — 44 имени не ложатся никаким словом: Armor (×22), Defense, Scepter, Life 2.5% (×10). Плюс «Реген HP 5%» →
  Life Regeneration (×12): сторож пускает, но политика Health — лежит в остатке вместе с ними.
- Транслит в именах типов (сторож требует ровно его, политика запрещает): Shestopyor, Oslop, `{adj} Sulitsa`, Chekan (×4), Crossbar Rogatina.
  Детали и анатомия уже английские (Flanged Mace, Iron-Bound Club, Javelin Shaft, Bear-Spear) — тип с ними не совпадает.
  Предложение полосы B: Flanged Mace / Iron-Bound Club / `{adj} Javelin` / Boar Spear (с перекладиной) / Axe-Hammer, Type … / Hammer-Poll Axe.
- Один стат — два слова в именах малых узлов: «Стойкость к прерыв. 3%» → Poise 3%, а «… 2.5%» → Interrupt Resistance 2.5%.
- «Аура гнева» → Aura of Wrath (глоссарий) против политики «гнев → Fury»: сторож предупреждает.
