# -*- coding: utf-8 -*-
"""
Карта 100 этажей для вкладки «Документация» — ВСЁ из живого конфига (цикл, шаг привала, лестница боссов,
ранги, ступени снаряжения, тиры вещей).

    python tools/docs/map100.py

Пишет `packages/editor/docs/library/lestnica-etazhey.md`. ПАДАЕТ, если схема владельца (15.10) разошлась с
конфигом: этажи 1–40 обязаны дать порталы 3/6/9/12/15/18/20 + 23/26/29/32/35/38/40 и боссов 5/14/19 + 25/34/39,
за актовым боссом обязан стоять портал (конец круга), и ни одно место лестницы не должно совпасть с порталом.
Так документ не может тихо разойтись с игрой.
"""
import io
import json
import sys

W = 'C:/work/Games_Art/Games_Art/dungeon_master/'
D = W + 'packages/shared/src/config/data/'
OUT = W + 'packages/editor/docs/library/lestnica-etazhey.md'

it = json.load(io.open(D + 'item-tiers.json', encoding='utf-8'))
mg = [x for x in json.load(io.open(D + 'monster-gear-tiers.json', encoding='utf-8')) if x.get('enabled', True)]
dt = json.load(io.open(D + 'depth-tiers.json', encoding='utf-8'))
bal = json.load(io.open(D + 'balance.json', encoding='utf-8'))
diffs = json.load(io.open(D + 'difficulties.json', encoding='utf-8'))
mder = json.load(io.open(D + 'monster-derive.json', encoding='utf-8'))
tpls = json.load(io.open(D + 'run-templates.json', encoding='utf-8'))
norm = [d for d in diffs if d['id'] == 'normal'][0]

ACC = bal['dungeonAccess']
CYCLE = ACC['contentCycle']
LADDER = {int(x['at']): x['rank'] for x in ACC['bossLadder']}
RANKS = ACC['bossRanks']
PCT = mder.get('bossRoomDepthPct', 0.1)
RU = {'mini': 'мини', 'strong': 'крепкий', 'act': 'актовый'}
ICON = {'mini': '◆ мини', 'strong': '◆◆ крепкий', 'act': '★ АКТОВЫЙ'}
# ⭐ Г8-3: места порталов — СПИСОК (интервалы неровные: …18, 20, затем 23 следующего круга).
PORTALS = tuple(sorted(int(p) for p in ACC['portalsAt'] if 1 <= int(p) <= CYCLE))


def level(f):
    return max(1, round(norm['startLevel'] + (max(1, f) - 1) * norm['floorStep']))


def band(f):
    return ((f - 1) % CYCLE) + 1 if CYCLE > 1 else f


def pick(rows, lvl, key):
    best = rows[0]
    for x in rows:
        if lvl >= x[key]:
            best = x
    return best


def dtier(bp):
    for x in dt:
        if x['fromFloor'] <= bp <= x['toFloor']:
            return x
    return dt[-1]


def boss_level(f, rank):
    m = max(0, RANKS[rank]['levelMult'])
    return level(f) + max(max(1, round(m)), round(level(f) * PCT * m))


portal_floors = [f for f in range(1, 101) if band(f) in PORTALS]
boss_floors = [(f, LADDER[band(f)]) for f in range(1, 101) if band(f) in LADDER]

# ── СВЕРКА СО СЛОВАМИ ВЛАДЕЛЬЦА (первые два круга) ──────────────────────────
WANT_P = [3, 6, 9, 12, 15, 18, 20, 23, 26, 29, 32, 35, 38, 40]
WANT_B = [5, 14, 19, 25, 34, 39]
got_p = [f for f in portal_floors if f <= 40]
got_b = [f for f, _ in boss_floors if f <= 40]
assert got_p == WANT_P, ('порталы: %s против %s' % (got_p, WANT_P))
assert got_b == WANT_B, ('боссы: %s против %s' % (got_b, WANT_B))
for p in PORTALS:
    assert p not in LADDER, 'место %d — и портал, и босс' % p
# ⭐⭐ Схема владельца: «на 19-м босс, 20-й портал и 21-й по новой всё» — актовый ЗАМЫКАЕТ круг, портал сразу за ним.
ACT_AT = [k for k, v in LADDER.items() if v == 'act'][0]
assert ACT_AT == CYCLE - 1, 'актовый босс на месте %d, а круг длиной %d' % (ACT_AT, CYCLE)
assert CYCLE in PORTALS, 'последнее место круга (%d) не портал — круг нечем замкнуть' % CYCLE
sys.stdout.buffer.write(('сверка со схемой (1–40): порталы %s · боссы %s — совпало\n' % (got_p, got_b)).encode('utf-8'))

# ⭐ Г8-3: самый длинный путь без портала считаем МЕЖДУ ПОРТАЛАМИ (с первого, а не от нуля:
# старт со входа — не «путь без портала», а начало забега).
gaps = [(portal_floors[i - 1], portal_floors[i], portal_floors[i] - portal_floors[i - 1]) for i in range(1, len(portal_floors))]
worst = max(gaps, key=lambda g: g[2])
t6 = [x for x in it if x['id'] == 't6'][0]

L = []
A = L.append
A('# Карта 100 этажей — цикл 20: порталы, боссы, ступени снаряжения')
A('')
A('> ⚠ ВСЁ В ЭТОМ ДОКУМЕНТЕ — ИЗ ЖИВОГО КОНФИГА (`balance.json` → `dungeonAccess` с лестницей боссов и рангами,')
A('> `difficulties.json`, `depth-tiers.json`, `monster-gear-tiers.json`, `item-tiers.json`, `monster-derive.json`,')
A('> `run-templates.json`), собрано скриптом. Схема сверяется автоматически: этажи 1–40 обязаны совпасть с тем,')
A(f'> что владелец расписал словами (порталы {", ".join(map(str, WANT_P))}; боссы {", ".join(map(str, WANT_B))}), и ни одно место лестницы')
A('> не должно совпадать с порталом — иначе скрипт падает.')
A('')
A('## Схема цикла (слова владельца 15.10)')
A('')
A('```')
A('этажи 1-2 · ПОРТАЛ 3 · 4-5 (5 — МИНИ-БОСС) · ПОРТАЛ 6 · 7-8 · ПОРТАЛ 9 · 10-11 · ПОРТАЛ 12 ·')
A('13-14 (14 — КРЕПКИЙ БОСС) · ПОРТАЛ 15 · 16-17 · ПОРТАЛ 18 · 19 — АКТОВЫЙ БОСС · ПОРТАЛ 20 →')
A('21-й — по новой всё (новый круг, новая ступень снаряжения монстров)')
A('```')
A('')
A(f'* **Цикл — {CYCLE} этажей.** Всё ниже считается от МЕСТА В ПОЛОСЕ: 21-й этаж = 1-е место, 40-й = 20-е.')
A(f'* **Порталы (привалы) — на местах {", ".join(map(str, PORTALS))} полосы** ({len(PORTALS)} на круг). Последнее место круга — тоже портал:')
A('  им круг и кончается («убил актового — вышел в город — 21-й по новой»).')
A('  ⚠ Это НЕ «каждые 3 этажа по абсолютному счёту»: интервалы неровные, и самый длинный путь без портала —')
A(f'  {worst[2]} этажа (с {worst[0]}-го на {worst[1]}-й; во втором круге то же между 20-м и 23-м). Уйти в город можно и с любого другого узла — от его точки входа;')
A('  портал даёт удобство и ТОЧКУ СТАРТА следующего забега.')
A(f'* **Боссы — на местах {", ".join(str(k) for k in sorted(LADDER))} полосы** ({", ".join(f"{k} — {RU[v]}" for k, v in sorted(LADDER.items()))}); ни одно место не совпадает с порталом.')
A(f'* **Уровень монстров = номер этажа** (тир «Средняя»: `startLevel` {norm["startLevel"]}, `floorStep` {norm["floorStep"]}). Цикл силу НЕ трогает.')
A(f'* **Надбавка босса**: доля глубины {PCT} × `levelMult` ранга ({", ".join(f"{RU[k]} ×{v['levelMult']}" for k, v in RANKS.items())}),')
A(f'  и жизнь комнаты × `hpMult` ({", ".join(f"{RU[k]} ×{v['hpMult']}" for k, v in RANKS.items())}).')
A('')
A('## Три лестницы рядом')
A('')
A('| что | шаг | где меняется | что это значит |')
A('| --- | --- | --- | --- |')
A(f'| Цикл контента | {CYCLE} этажей | {", ".join(str(1 + CYCLE * k) for k in range(1, 5))} | сцена и мешанина монстров начинают круг заново |')
A(f'| Ступень снаряжения МОНСТРА | 10 уровней | **{", ".join(str(x["fromLevel"]) for x in mg[1:5])}, …** | статы его гира ×{mg[1]["statMult"] / mg[0]["statMult"]:.1f} за ступень (m0 → m1 → …) |')
A('| Ступень гира ИГРОКА (что падает) | по уровню вещи | ' + ', '.join(f'{x["id"]} с {x["minItemLevel"]}' for x in it) + ' | уровень вещи = уровень монстра |')
A('')
A('⭐⭐ **БОСС ЗАМЫКАЕТ КРУГ, А КРУГ — СТУПЕНЬ ГИРА (решение владельца 15.10).** Ступень снаряжения монстров меняется')
A(f'не на 10/20/30, а на **{", ".join(str(x["fromLevel"]) for x in mg[1:4])}** — то есть ровно с ПЕРВОГО этажа круга. Круг кончается боем с актовым')
A(f'боссом ({", ".join(str(f) for f, r in boss_floors if r == "act")}), сразу за ним портал ({", ".join(str(f + 1) for f, r in boss_floors if r == "act")}) — вышел в город, продал, — а с ')
A(f'{", ".join(str(f + 2) for f, r in boss_floors if r == "act")} все монстры уже в новом гире. Это и есть «проверка на прочность: прошёл — дальше сильнее».')
A('')
A('⚠ **ЧТО НЕ ЗАМКНУТО.** Ступень снаряжения меняется каждые 10 уровней (11, 21, 31, …), а круг — каждые 20 этажей.')
A(f'Значит актовый босс замыкает КАЖДУЮ ВТОРУЮ ступень ({", ".join(str(f) for f in range(20, 101, 20))} — последние этажи ступеней), а середина')
A('круга (10, 30, 50, …) ступень меняет БЕЗ босса: на 11-м этаже монстры уже в новом гире, а проверки не было. Чтобы')
A('боссом замыкалась каждая ступень, второго босса надо переставить с места **14** на **9** полосы (тогда он встанет на')
A('9, 29, 49, … — перед сменой на 11, 31, 51). Лестница живёт в данных (`balance.dungeonAccess.bossLadder`) — это правка')
A('ОДНОГО числа, и ждёт решения владельца.')
A('')
A(f'⚠ **ПОТОЛОК ШМОТА.** Последняя ступень вещей `t6` открывается с {t6["minItemLevel"]}-го уровня вещи, то есть с {t6["minItemLevel"]}-го этажа —')
A('и дальше новых ступеней НЕТ ни на 100-м, ни на 300-м этаже. Для прицела 200–300 этажей лестницу придётся')
A('продлевать (отложенный пункт Г9 «лут глубины»).')
A('')
A('## Боссы до 100-го этажа')
A('')
A('| ранг | место в полосе | этажи | ур. босса на них | жизнь комнаты | размер этажа |')
A('| --- | --- | --- | --- | --- | --- |')
for rank in ('mini', 'strong', 'act'):
    at = [k for k, v in sorted(LADDER.items()) if v == rank]
    fl = [f for f, r in boss_floors if r == rank]
    lv = ', '.join(str(boss_level(f, rank)) for f in fl)
    A(f'| {ICON[rank]} | {", ".join(map(str, at))} | {", ".join(map(str, fl))} | {lv} | ×{RANKS[rank]["hpMult"]} | ×{RANKS[rank].get("floorScale", 1)} |')
A('')
A('⭐ **ЗАМЕР СИЛЫ (15.10, настоящим путём заселения).** Боссовая комната и так форсит редкость `unique` (жизнь ×3),')
A('поэтому ранг добавляет своё: к боссу БЕЗ ранга мини даёт ×1.00, крепкий ×1.70, актовый ×3.19 — и прибавка актового')
A('держится на всей глубине (×3.19 на 20-м этаже, ×3.31 на 40-м, ×3.41 на 100-м). Сам бой с боссом при этом тяжелее')
A('рядовых монстров того же этажа в десятки раз: комната тянет сильные заготовки (`tierHp`) поверх надбавки ранга.')
A('')
A('⭐⭐ **БОССОВЫЙ ЭТАЖ БОЛЬШЕ ПО РАЗМЕРУ (Г8-3, просьба владельца).** `floorScale` ранга растягивает сетку этажа')
SCALE_TXT = ', '.join('%s ×%s' % (RU[k], v.get('floorScale', 1)) for k, v in RANKS.items())
A(f'({SCALE_TXT}), а число комнат едет ПО ПЛОЩАДИ — иначе этаж стал бы не крупнее, а пустее')
A('(комнаты у генератора фиксированного размера в клетках). Замер 15.10: рядовой боссовый этаж крипты 58×44, актовый')
A('78×59, ходибельных клеток 1184 → 2111 (×1.78) при той же плотности застройки (45,6 % → 44,4 %).')
A('')
A('## Полная карта 1–100')
A('')
A('Обозначения: **⌂** — портал в город (привал) · **◆** мини-босс · **◆◆** крепкий · **★** актовый ·')
A('«мешанина» — тир глубины (`depth-tiers`), по которому берутся силовые типы монстров на этаже.')
A('')
A('| этаж | в полосе | что на этаже | ур. монстров | ур. босса | гир монстра | гир игрока (падает) | мешанина |')
A('| --- | --- | --- | --- | --- | --- | --- | --- |')
for f in range(1, 101):
    bp = band(f)
    lv = level(f)
    g = pick(mg, lv, 'fromLevel')
    tt = pick(it, lv, 'minItemLevel')
    d = dtier(bp)
    rank = LADDER.get(bp)
    what = []
    if bp in PORTALS:
        what.append('⌂ портал')
    if rank:
        what.append(ICON[rank])
    if not what:
        what.append('бой')
    if bp == 1:
        what.append('(начало круга)')
    A(f'| **{f}** | {bp} | {" · ".join(what)} | {lv} | {boss_level(f, rank) if rank else ""} | {g["id"]} {g["name"]} ×{g["statMult"]} | {tt["id"]} {tt["name"]} | {d["id"]} |')
A('')
A('## Что из этой карты в коде')
A('')
A('| пункт | статус |')
A('| --- | --- |')
A(f'| Цикл контента {CYCLE} этажей (сцена, тайлсет, мешанина монстров) | ✅ Г8-1, 15.10 |')
A('| Уровень монстра = номер этажа, без потолка | ✅ Г1, 13.10 |')
A(f'| Порталы на местах {", ".join(map(str, PORTALS))} ПОЛОСЫ (списком, интервалы неровные) | ✅ Г8-3, 15.10 (`portalsAt`) |')
A(f'| Боссы на местах {", ".join(str(k) for k in sorted(LADDER))} полосы, три ранга | ✅ Г8-2, 15.10 (`bossLadder` + `bossRanks`) |')
A(f'| Актовый босс замыкает круг, портал сразу за ним ({ACT_AT} → {CYCLE}) | ✅ Г8-3, 15.10 |')
A('| Ступени снаряжения монстра с 11/21/31 | ✅ 15.10 (решение владельца) |')
A(f'| Боссовый этаж крупнее (×{RANKS["act"].get("floorScale", 1)} у актового) | ✅ Г8-3, 15.10 (`floorScale` → `resolveFloorSpec`) |')
A('| Карта круга на алтаре — выбор старта кликом | ✅ Г8-3, 15.10 (веб + Unity) |')
A('| Настройка этой таблицы в редакторе конфигов | ✅ Г8-3, 15.10 (вкладка «🔄 Круг забега») |')
A(f'| Ступени вещей глубже {t6["minItemLevel"]}-го уровня | ⏳ нет вовсе (отложено с Г9) |')
A(f'| Шаблоны забега сняты, забег один ({", ".join(x["id"] for x in tpls)}) | ✅ Г8-4, 15.10 (решение владельца) |')
A('| Боссы и метки — ТОЛЬКО по этой таблице (шаблон и состав этажей их не отменяют) | ✅ Г8-4, 15.10 |')
A('')

txt = '\n'.join(L) + '\n'
io.open(OUT, 'w', encoding='utf-8', newline='\n').write(txt)
sys.stdout.buffer.write(('записан %s, строк %d\n' % (OUT.split('/')[-1], len(L))).encode('utf-8'))
sys.stdout.buffer.write(('порталов до 100: %d, боссов %d; самый длинный путь без портала: %d→%d (%d)\n'
                         % (len(portal_floors), len(boss_floors), worst[0], worst[1], worst[2])).encode('utf-8'))
