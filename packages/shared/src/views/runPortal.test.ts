import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { nextWaypointAfter, openWaypoints, portalPlaces, floorMonsterLevel } from '../formulas/power.js';
import { runModCount } from '../dungeon/run/runModEffects.js';
import { sealBuffs, sealTierMul } from '../economy/seals.js';
import { RUN_PORTAL_TEXT, runChainMap, runHiddenMarkTitle, runPortalView, type RunAltarModel } from './runPortal.js';
import { RUN_SEGMENT_TEXT, runSegmentView } from './runSegment.js';

/**
 * ⭐⭐ С-views (29.10): ОКНО «ПОРТАЛ» И АЛТАРЬ ОТРЕЗКА — случаи `PortalCheck.cs` Unity, перенесённые на виды сервера.
 *
 * У `PortalCheck` нет веб-эталона: его случаи живут в самой проверке Unity над своим маленьким конфигом. Здесь — тот же конфиг
 * (разобранный схемами: виды зовут реестр, как сервер) и те же утверждения, плюс точные строки окна, которые C#-порт собирал
 * (`Altar.Model`/`Altar.SegmentModel`), и сторож формы: ключи результата — ровно поля C#-классов, в порядке объявления.
 */

type Raw = Record<string, unknown>;
const BASE = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.snapshot() as unknown as Raw; })();

/** Конфиг стенда `PortalCheck.Cfg()`: один включённый тир, два биома, круг 20 с порталами 3…20 и боссом на 5. */
function portalCfg(patch?: (c: Raw) => void): ConfigRegistry {
  const c = structuredClone(BASE);
  const biomes = (c.biomes as Raw[]).filter((b) => b.id === 'crypt' || b.id === 'caves');
  for (const b of biomes) {
    b.enabled = true;
    if (b.id === 'crypt') { b.name = 'Склеп'; b.tagline = 'Холодно'; } else { b.name = 'Пещеры'; b.tagline = ''; b.desc = ''; }
  }
  c.biomes = biomes;
  c.difficulties = [
    { id: 'normal', name: 'Средняя', unlockFloor: 0, goldMult: 1, magicFind: 1, startLevel: 1, floorStep: 1 },
    { id: 'hard', name: 'Сложная', unlockFloor: 10, enabled: false, goldMult: 1.3, magicFind: 1.2, startLevel: 5, floorStep: 1 },
  ];
  c['run-mod-stats'] = [
    { id: 'packSize', name: 'Размер пачки', enabled: true, node: false, cap: 1 },
    { id: 'itemRolls', name: 'Число вещей', enabled: true, node: false, cap: 1.5 },
    { id: 'monsterHp', name: 'Жизнь монстров', enabled: true, node: false, cap: 1.5 },
    { id: 'xp', name: 'Опыт', enabled: false, node: false, cap: 1.5 },
  ];
  c.seals = [
    { id: 'swarming', name: 'Кишащий', desc: 'Пачки крупнее', danger: { stat: 'packSize', value: 0.2 }, reward: { stat: 'itemRolls', value: 0.15 } },
    { id: 'enduring', name: 'Стойкие', danger: { stat: 'monsterHp', value: 0.25 }, reward: { stat: 'xp', value: 0.2 } },
  ];
  const b = c.balance as Raw;
  b.power = { gearRarityWeight: { normal: 1, magic: 2, rare: 3, unique: 5 }, gearDivisor: 3, gearMax: 5, passiveDivisor: 5, passiveMax: 2 };
  b.dungeonAccess = { ...(b.dungeonAccess as Raw), portalsAt: [3, 6, 9, 12, 15, 18, 20], contentCycle: 20, bossLadder: [{ at: 5, rank: 'mini' }], width: { min: 1, max: 3 } };
  b.seals = {
    ...(b.seals as Raw), enabled: true, dangerCapPerSeal: 10, stackMax: 20,
    tiers: [{ id: 't1', name: 'I', mul: 1 }, { id: 't2', name: 'II', mul: 2.2 }],
    slots: [{ fromRecord: 0, count: 1 }, { fromRecord: 20, count: 2 }],
  };
  patch?.(c);
  const r = new ConfigRegistry();
  r.loadAll(c, { cross: false });
  return r;
}

/** Сейв `PortalCheck.Save(record)`: 10-й уровень, пустые сумка и снаряжение. */
function save(record: number, more: Partial<SaveState> = {}): SaveState {
  return {
    version: 1, name: 'Стенд', charId: 'c1', createdAt: 0, classId: 'warrior', level: 10, xp: 0, gold: 0,
    attributes: { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 }, unspentAttributePoints: 0, unspentSkillPoints: 0,
    unspentMasteryPoints: 0, skills: {}, masteries: {}, equipment: {}, inventory: [], stash: [], belt: [], mouseLeft: null,
    mouseRight: null, hotbar: [], quests: [], activeQuestDefs: [], maxDepth: 0,
    difficultyProgress: record > 0 ? { normal: record } : {}, lastDifficulty: 'normal', ...more,
  } as SaveState;
}
const seal = (uid: string, sealId: string, sealTier: string, count: number): Item => ({ uid, kind: 'seal', sealId, sealTier, count } as unknown as Item);

/** Поля C#-классов в порядке объявления — ключи модели обязаны совпасть РОВНО. */
const FIELDS = {
  AltarModel: ['power', 'head', 'biomeNote', 'biomes', 'templates', 'mods', 'tiers'],
  PowerBreakdown: ['level', 'gearBonus', 'passiveBonus', 'total'],
  AltarChip: ['id', 'name', 'title', 'active'],
  AltarTier: ['id', 'name', 'meta', 'line', 'variant', 'lockText', 'unlocked', 'descend', 'restart', 'map', 'start'],
  AltarChainMap: ['nodes', 'links', 'dividers', 'width', 'height', 'r', 'cycle', 'record', 'openCount', 'pick', 'start', 'hidden', 'hiddenMarks', 'hiddenTitles'],   // ⭐ С6: + подписи скрытых меток
  ChainNode: ['depth', 'place', 'x', 'y', 'level', 'open', 'pick', 'entry', 'label', 'title'],
  ChainBoss: ['depth', 'x', 'y', 'level', 'rank', 'mark', 'title'],
  ChainStrand: ['points', 'main'],
  ChainLink: ['from', 'to', 'strands', 'boss', 'gapText', 'gapX', 'gapY'],
  ChainDivider: ['y', 'circle', 'label'],
  AltarStart: ['depth', 'line', 'note'],
  SegmentModelView: ['line', 'note', 'hint', 'paid', 'notMine', 'seals', 'summary', 'from', 'to', 'slots', 'used', 'refusal'],   // ⭐ С6: + отказ набора
  SealCard: ['key', 'name', 'danger', 'reward', 'desc', 'carried', 'picked', 'canAdd'],   // ⭐ С6: + «можно ещё одну»
} as const;
const keysOf = (o: object): string[] => Object.keys(o);

function checkAltarShape(m: RunAltarModel): void {
  expect(keysOf(m)).toEqual(FIELDS.AltarModel);
  expect(keysOf(m.power)).toEqual(FIELDS.PowerBreakdown);
  for (const c of m.biomes) expect(keysOf(c)).toEqual(FIELDS.AltarChip);
  for (const t of m.tiers) {
    expect(keysOf(t)).toEqual(FIELDS.AltarTier);
    if (t.descend) expect(keysOf(t.descend)).toEqual(['t', 'difficultyId', 'startDepth', 'runConfig']);
    if (t.start) expect(keysOf(t.start)).toEqual(FIELDS.AltarStart);
    if (!t.map) continue;
    expect(keysOf(t.map)).toEqual(FIELDS.AltarChainMap);
    for (const n of t.map.nodes) expect(keysOf(n)).toEqual(FIELDS.ChainNode);
    for (const d of t.map.dividers) expect(keysOf(d)).toEqual(FIELDS.ChainDivider);
    for (const l of t.map.links) {
      expect(keysOf(l)).toEqual(FIELDS.ChainLink);
      if (l.boss) expect(keysOf(l.boss)).toEqual(FIELDS.ChainBoss);
      for (const s of l.strands) { expect(keysOf(s)).toEqual(FIELDS.ChainStrand); for (const p of s.points) expect(keysOf(p)).toEqual(['x', 'y']); }
    }
  }
  // ⚠ Модель — простой JSON: круг через `JSON` ничего не теряет (нет undefined, функций, Map).
  expect(JSON.parse(JSON.stringify(m))).toEqual(m);
}

describe('С-views: окно «Портал» (PortalCheck)', () => {
  const cfg = portalCfg();
  const access = cfg.get('balance').dungeonAccess;

  it('свежий герой: одна открытая карточка, меток нет, «начать сначала» ведёт на 1-й этаж без модификаторов', () => {
    const m = runPortalView(cfg, save(0));
    checkAltarShape(m);
    expect(m.tiers.length).toBe(1);
    const t = m.tiers[0]!;
    expect(t.unlocked).toBe(true);
    expect(t.map!.nodes.length).toBe(0);
    expect(t.restart).toEqual({ t: 'descend', difficultyId: 'normal', startDepth: 1, runConfig: { biomeId: 'crypt', modifiers: [] } });
    expect(RUN_PORTAL_TEXT.title).toBe('Портал');
    expect(RUN_PORTAL_TEXT.tiersSection).toContain('Маршрут');
    // точные строки C#-порта
    expect(m.head).toBe('Мощь персонажа: 10 (ур. 10 + гир +0 + мастерства +0)');
    expect(m.power).toEqual({ level: 10, gearBonus: 0, passiveBonus: 0, total: 10 });
    expect([t.id, t.name, t.meta, t.line, t.variant, t.lockText]).toEqual(['normal', 'Средняя', 'золото ×1 · редкость ×1', 'Монстры на 1-м этаже — ур. 1, глубже — сложнее.', 'primary', null]);
    expect(t.map!.start).toBe('Старт: этаж 1 · монстры ур. 1 · других меток пока нет');
    expect(t.map!.height).toBe(68);
    expect(t.start!.note).toBe('⌂ — портал (отсюда можно начать), ✦/✧✧/★ — мини/крепкий/актовый босс. Открыты метки не глубже ВАШЕГО рекорда (0). '
      + 'В пати старт зажимается по самому мелкому рекорду — точную глубину назовёт окно голосования.');
    expect(m.biomes).toEqual([{ id: 'crypt', name: 'Склеп', title: 'Холодно', active: true }, { id: 'caves', name: 'Пещеры', title: null, active: false }]);
    expect(m.biomeNote).toBe('Холодно');
    expect([m.templates, m.mods]).toEqual([[], []]);
  });

  it('рекорд 14: цепь = openWaypoints бит в бит (3/6/9/12), входа нет, всё открыто; босс 5 на звене 3→6', () => {
    const m = runPortalView(cfg, save(14));
    checkAltarShape(m);
    const t = m.tiers[0]!;
    const marks = openWaypoints({ normal: 14 }, 'normal', access.portalsAt, access.contentCycle);
    expect(marks).toEqual([3, 6, 9, 12]);
    expect(t.map!.nodes.map((n) => n.depth)).toEqual(marks);
    expect(t.map!.nodes.every((n) => !n.entry && n.open)).toBe(true);
    expect(t.restart!.startDepth).toBe(1);
    expect(t.map!.links[0]!.boss).toMatchObject({ depth: 5, rank: 'mini', mark: '✦', level: 5, title: 'мини-босс — этаж 5, монстры ур. 5' });
    expect(t.map!.links[0]!.gapText).toBeNull();
    expect(t.map!.links[1]!.gapText).toBe('2 эт.');
    expect(t.map!.start).toBe('Старт: этаж 1 · монстры ур. 1 · открыто меток: 4');
    expect(t.map!.nodes[0]!.title).toBe('Портал — этаж 3, монстры ур. 3. Можно начать отсюда.');
    expect(t.start!.note).toContain('ВАШЕГО рекорда (14)');
  });

  it('выбор метки доезжает до «Войти»; метка за рекордом откатывается ко входу', () => {
    const t = runPortalView(cfg, save(14), { depth: 9 }).tiers[0]!;
    expect(t.descend!.startDepth).toBe(9);
    expect(t.map!.nodes.filter((n) => n.pick).length).toBe(1);
    expect(t.start!.depth).toBe(9);
    expect(t.map!.start).toBe('Старт: этаж 9 · монстры ур. 9 · открыто меток: 4');
    expect(runPortalView(cfg, save(14), { depth: 99 }).tiers[0]!.descend!.startDepth).toBe(1);
  });

  it('биом остаётся выбором маршрута и уходит в кадр; пропавший биом — первый включённый', () => {
    const m = runPortalView(cfg, save(6), { biome: 'caves' });
    expect(m.biomes.length).toBe(2);
    expect(m.biomes.find((b) => b.id === 'caves')!.active).toBe(true);
    expect(m.tiers[0]!.descend!.runConfig.biomeId).toBe('caves');
    expect(m.biomeNote).toBeNull();
    expect(RUN_PORTAL_TEXT.biomeSection).toContain('лететь');
    expect(runPortalView(cfg, save(6), { biome: 'ghost' }).tiers[0]!.descend!.runConfig.biomeId).toBe('crypt');
  });

  it('замок тира: «🔒 Пройди этаж N на «тир» (сейчас M)» и карточка без кнопок', () => {
    const locked = portalCfg((c) => { (c.difficulties as Raw[])[1]!.enabled = true; });
    const m = runPortalView(locked, save(7));
    checkAltarShape(m);
    expect(m.tiers.length).toBe(2);
    const h = m.tiers[1]!;
    expect([h.unlocked, h.lockText, h.descend, h.restart, h.map, h.start, h.variant]).toEqual([false, '🔒 Пройди этаж 10 на «Средняя» (сейчас 7)', null, null, null, null, null]);
    expect(h.meta).toBe('золото ×1.3 · редкость ×1.2');
    expect(h.line).toBe('Монстры на 1-м этаже — ур. 5, глубже — сложнее.');
    const open = runPortalView(locked, save(10)).tiers[1]!;
    expect([open.unlocked, open.variant]).toEqual([true, 'primary']);   // i = 1 → primary (danger — с третьего тира)
  });

  it('глубокий рекорд: цепь — последние 48 меток, остальные в hiddenMarks и строке; разделители кругов на звеньях', () => {
    const m = runPortalView(cfg, save(400));
    checkAltarShape(m);
    const map = m.tiers[0]!.map!;
    const marks = openWaypoints({ normal: 400 }, 'normal', access.portalsAt, access.contentCycle);
    expect(map.nodes.length).toBe(48);
    expect(map.hiddenMarks).toEqual(marks.slice(0, marks.length - 48));
    expect(map.hiddenTitles, 'подпись — на каждую скрытую метку').toEqual(map.hiddenMarks.map(runHiddenMarkTitle));
    expect(map.hidden).toBe(`Выше ещё меток: ${marks.length - 48} (этажи 1–${map.hiddenMarks[map.hiddenMarks.length - 1]})`);
    expect(map.dividers.length).toBeGreaterThan(0);
    for (const d of map.dividers) expect(d.label).toBe(`круг ${d.circle}`);
    expect(map.links.some((l) => l.strands.length > 1)).toBe(true);
    expect(map.height).toBe(map.nodes[47]!.y + 34);
  });

  // ⭐ Геометрия цепи — порт C# `ChainMap`, а он — порт веба `altarChainView`. Веб-функция жива (клиент её не удалял), и если
  // она на месте — сверяем числа бит в бит на широкой выборке. Нет веб-клиента — сторож пропускается.
  const WEB = fileURLToPath(new URL('../../../client/src/modules/town/altarMapLayout.ts', import.meta.url));
  it.skipIf(!existsSync(WEB))('цепь бит в бит с веб-исходником правила (altarChainView), если он рядом', async () => {
    const mod = await import(/* @vite-ignore */ WEB.replace(/\.ts$/, '.js')) as {
      altarChainView: (marks: number[], record: number, places: unknown, cycle: number, ladder: unknown, pick: number, levelOf: (d: number) => number, widthMax?: number) => {
        nodes: Raw[]; links: { from: number; to: number; strands: { points: { x: number; y: number }[]; main: boolean }[]; boss: Raw | null; gap: { text: string; x: number; y: number } | null }[];
        dividers: Raw[]; width: number; height: number; r: number; cycle: number; record: number; openCount: number; pick: number; start: string; hidden: string | null; hiddenMarks: number[];
      };
    };
    const diff = cfg.get('difficulties')[0]!;
    const ladder = [{ at: 5, rank: 'mini' }, { at: 14, rank: 'strong' }, { at: 19, rank: 'act' }];
    let n = 0;
    for (const [places, cycle] of [[[3, 6, 9, 12, 15, 18, 20], 20], [3, 20], [3, 0], [2, 5]] as const) {
      for (const record of [0, 3, 14, 40, 133, 300, 1000]) {
        for (const widthMax of [1, 2, 3, 5]) {
          const marks = openWaypoints({ normal: record }, 'normal', places, cycle);
          for (const pick of [1, marks[0] ?? 1, marks[marks.length - 1] ?? 1]) {
            const levelOf = (d: number): number => floorMonsterLevel(diff, d);
            const mine = runChainMap(marks, record, places, cycle, ladder, pick, levelOf, widthMax);
            const web = mod.altarChainView(marks, record, places, cycle, ladder, pick, levelOf, widthMax);
            const webFlat = {
              ...web,
              links: web.links.map((l) => ({ from: l.from, to: l.to, strands: l.strands, boss: l.boss, gapText: l.gap?.text ?? null, gapX: l.gap?.x ?? 0, gapY: l.gap?.y ?? 0 })),
            };
            const { hiddenTitles: _ht, ...mineWeb } = mine;   // ⭐ С6: подписи скрытых меток — поле вида, у веб-исходника его нет
            expect({ ...mineWeb }, `места ${JSON.stringify(places)} цикл ${cycle} рекорд ${record} ширина ${widthMax} старт ${pick}`)
              .toEqual({ ...webFlat, nodes: web.nodes, dividers: web.dividers });
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(300);
  });
});

describe('С-views: алтарь отрезка на метке (PortalCheck, Ф4 + Ф5)', () => {
  const cfg = portalCfg();
  const access = cfg.get('balance').dungeonAccess;
  const places = portalPlaces(access.portalsAt, access.contentCycle);
  const mark = places[1]!;
  const to = nextWaypointAfter(mark, access.portalsAt, access.contentCycle);
  const bag = (): SaveState => save(mark + 40, { inventory: [seal('s1', 'swarming', 't1', 5), seal('s2', 'enduring', 't1', 2)] });
  const at = { depth: mark, tierId: 'normal' };

  it('отрезок от следующего за меткой до следующей метки; карточки — из сумки; мёртвый вид не предложен; гнёзда по рекорду', () => {
    const m = runSegmentView(cfg, bag(), at, {});
    expect(Object.keys(m)).toEqual(FIELDS.SegmentModelView);
    for (const s of m.seals) expect(Object.keys(s)).toEqual(FIELDS.SealCard);
    expect([m.from, m.to]).toEqual([mark + 1, to]);
    expect(m.line).toBe(`Отрезок: этажи ${mark + 1}–${to} (до следующей метки)`);
    expect(m.note).toBe(RUN_SEGMENT_TEXT.note);
    expect(m.seals.length).toBe(1);
    expect(m.seals.every((s) => s.key !== 'enduring@t1')).toBe(true);
    expect(m.seals[0]).toEqual({
      key: 'swarming@t1', name: 'Кишащий I', danger: 'Опаснее: Размер пачки +20 %', reward: 'Богаче: Число вещей +15 %', desc: 'Пачки крупнее',
      carried: 5, picked: 0, canAdd: true,
    });
    expect(m.slots).toBe(2);
    expect([m.summary, m.used, m.paid, m.notMine]).toEqual([[], 0, false, false]);
    expect(m.hint).toBe(RUN_SEGMENT_TEXT.hint);
  });

  it('вставленное видно на карточке и в счётчике; свод называет ЧИСЛА, которые применит сервер', () => {
    const m1 = runSegmentView(cfg, bag(), at, { 'swarming@t1': 1 });
    expect([m1.used, m1.seals[0]!.picked]).toEqual([1, 1]);
    expect(m1.summary).toEqual(['Размер пачки ×1.20', 'Число вещей ×1.15']);
    const b = sealBuffs(cfg, { 'swarming@t1': 1 });
    expect([b.packSize, b.itemRolls]).toEqual([1.2, 1.15]);
  });

  it('потолки сидят в ядре (sealBuffs): стопка насыщается, мусор и выдуманная ступень не действуют', () => {
    const b5 = sealBuffs(cfg, { 'swarming@t1': 5 });
    const b100 = sealBuffs(cfg, { 'swarming@t1': 100 });
    const b1 = sealBuffs(cfg, { 'swarming@t1': 1 });
    expect(Math.abs(b5.packSize - 2)).toBeLessThan(1e-9);
    expect(Math.abs(b100.packSize - b5.packSize)).toBeLessThan(1e-9);
    expect(b1.packSize).toBeLessThan(b5.packSize - 1e-9);
    expect(sealTierMul(cfg, 't9')).toBe(0);
    expect(Object.values(sealBuffs(cfg, { 'безступени': 3 })).every((x) => x === 1)).toBe(true);
    const bN = sealBuffs(cfg, { 'swarming@t1': 20 });
    expect(bN.itemRolls - 1).toBeLessThanOrEqual((b1.itemRolls - 1) * 5 + 1e-9);
    // допуск связки разных видов: 0.3 × 2 печати = +60 %
    const withXp = (allow: number): ConfigRegistry => portalCfg((c) => {
      for (const s of c['run-mod-stats'] as Raw[]) if (s.id === 'xp') s.enabled = true;
      ((c.balance as Raw).seals as Raw).dangerCapPerSeal = allow;
    });
    const mixed = { 'swarming@t2': 1, 'enduring@t2': 1 };
    const loose = sealBuffs(withXp(10), mixed), tight = sealBuffs(withXp(0.3), mixed);
    expect(Math.abs((tight.packSize - 1) + (tight.monsterHp - 1) - 0.6)).toBeLessThan(1e-9);
    expect(tight.itemRolls).toBeLessThan(loose.itemRolls - 1e-9);
    expect(Math.abs(sealBuffs(withXp(0.3), { 'swarming@t2': 1 }).packSize - 1 - 0.3)).toBeLessThan(1e-9);
  });

  it('первый заход объясняет, второй — нет (отметка из сейва)', () => {
    expect(runSegmentView(cfg, { ...bag(), seen: ['altar'] }, at, {}).hint).toBeNull();
  });

  it('счётный стат — ШТУКАМИ: карточка «+1», награда — процентами, свод «Логова +1»', () => {
    const evt = portalCfg((c) => {
      (c['run-mod-stats'] as Raw[]).push({ id: 'elitePacks', name: 'Логова', enabled: true, node: false, unit: 'count', perUnit: 1.4, cap: 2.8 });
      (c.seals as Raw[]).push({ id: 'lair', name: 'Логово', desc: 'Комната редких', danger: { stat: 'elitePacks', value: 1.4 }, reward: { stat: 'itemRolls', value: 1 } });
    });
    const s = { ...bag(), inventory: [...bag().inventory, seal('L1', 'lair', 't1', 2)] };
    const mv = runSegmentView(evt, s, at, { 'lair@t1': 1 });
    const card = mv.seals.find((c) => c.key === 'lair@t1')!;
    expect(card.danger).toBe('Опаснее: Логова +1');
    expect(card.reward).toContain('%');
    expect(mv.summary.find((x) => x.startsWith('Логова'))).toBe('Логова +1');
    expect([runModCount(2.4, 1.4), runModCount(3.8, 1.4), runModCount(2.39, 1.4), runModCount(1.9, 0.9), runModCount(2.8, 0.9), runModCount(1.89, 0.9), runModCount(2), runModCount(1.99)])
      .toEqual([1, 2, 0, 1, 2, 0, 1, 0]);
  });

  it('печать чужого биома не предложена, и окно говорит почему', () => {
    const byBiome = portalCfg((c) => {
      (c.seals as Raw[])[0]!.biomes = ['caves'];
      for (const s of c['run-mod-stats'] as Raw[]) if (s.id === 'xp') s.enabled = true;
    });
    const m = runSegmentView(byBiome, bag(), at, {});
    expect(m.seals.some((c) => c.key === 'swarming@t1')).toBe(false);
    expect(m.note).toBe(`${RUN_SEGMENT_TEXT.note} Печатей другого биома в сумке: 5 — здесь они не действуют.`);
    expect(Object.values(sealBuffs(byBiome, { 'swarming@t1': 1 }, 'crypt')).every((x) => x === 1)).toBe(true);
    const inCaves = runSegmentView(byBiome, bag(), { ...at, biomeId: 'caves' }, {});
    expect(inCaves.seals.map((c) => c.key).sort()).toEqual(['enduring@t1', 'swarming@t1']);
  });

  it('оплаченный отрезок: только сообщает связку (из сейва или из факта комнаты)', () => {
    const paid = { ...bag(), run: { segment: { from: mark + 1, to, seals: { 'swarming@t1': 2 } } } } as unknown as SaveState;
    const m2 = runSegmentView(cfg, paid, at, {});
    expect([m2.paid, m2.seals.length, m2.note]).toEqual([true, 0, RUN_SEGMENT_TEXT.paid]);
    expect(m2.line).toBe(`Отрезок ${mark + 1}–${to} уже настроен: Кишащий I ×2`);
    const roomPaid = runSegmentView(cfg, bag(), { ...at, segment: { from: mark + 1, seals: { 'swarming@t1': 1, 'enduring@t1': 1 } } }, {});
    expect(roomPaid.line).toBe(`Отрезок ${mark + 1}–${to} уже настроен: Кишащий I, Стойкие I`);
  });

  it('право настройки: у начавшего забег; факт комнаты (`mayTune`) важнее сейва', () => {
    const mate = { ...bag(), charId: 'mate-1', run: { starter: 'owner-1' } } as unknown as SaveState;
    const m3 = runSegmentView(cfg, mate, at, {});
    expect([m3.notMine, m3.seals.length, m3.note]).toEqual([true, 0, RUN_SEGMENT_TEXT.notMine]);
    expect(runSegmentView(cfg, { ...mate, charId: 'owner-1' } as SaveState, at, {}).notMine).toBe(false);
    expect(runSegmentView(cfg, { ...bag(), charId: 'solo-1' }, at, {}).notMine).toBe(false);
    // ⚠ сервер: владельца в комнате нет — решают оставшиеся (`Room.mayTuneSegment`), окно Unity этого не знало
    expect(runSegmentView(cfg, mate, { ...at, mayTune: true }, {}).notMine).toBe(false);
    expect(runSegmentView(cfg, { ...bag(), charId: 'solo-1' }, { ...at, mayTune: false }, {}).notMine).toBe(true);
  });

  it('на обычном этаже алтаря нет — модель пуста', () => {
    const plain = runSegmentView(cfg, bag(), { depth: mark + 1, tierId: 'normal' }, null);
    expect(plain).toEqual({ line: 'Здесь алтаря нет.', note: null, hint: null, paid: false, notMine: false, seals: [], summary: [], from: 0, to: 0, slots: 0, used: 0, refusal: null });
  });
});
