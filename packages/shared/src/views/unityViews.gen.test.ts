/**
 * ⭐ С2/С4–С6 (29.10): ПРОДЮСЕР ЭТАЛОНА «ВИДЫ СЕРВЕРА → МОДЕЛИ ОКОН UNITY». Сервер шлёт окнам Unity модели (кадры `hero` и `view`), а
 * Unity разбирает их в свои классы (`JToken.ToObject<T>()`): этот файл кладёт образцы ровно тех моделей, что отдаёт сервер, — их считают
 * функции `views/` от настоящего конфига, — и Unity-сторож `ViewsCheck` разбирает каждый в свой класс и сверяет, что ни одно поле не
 * потерялось. Правил здесь нет: только образцы провода.
 *
 * Сейв-образец «богатый»: вещи в сумке (оружие и броня разных редкостей), стопки сырья, печати, кошелёк сундука, план забега — чтобы у каждой
 * модели были заполнены все ветки (пустой список Newtonsoft разберёт и в класс без нужного поля, и потерю никто не увидит).
 *
 * Эталон: `__golden__/unity_views.json` → Unity `Assets/DM/UI/Tests/unity_views_golden.json` (`tools/unity-check/golden_sync.py`).
 * Перезапись: `npx vitest run packages/shared/src/views/unityViews.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigRegistry } from '../config/registry.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { materialItem } from '../economy/materials.js';
import { sealItem, sealTiers } from '../economy/seals.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { xpProgress } from '../formulas/xp.js';
import { generateRunPlan } from '../dungeon/run/generateRunPlan.js';
import { acceptQuest, ensureMainQuest, generateBoard } from '../economy/questLogic.js';
import type { Item } from '../types/items.js';
import { addToInventory } from '../inventory/grid.js';
import type { AccountStash } from '../types/stash.js';
import { heroNumbers, masterBlock, hudInfo, sheetView, skillTreeView } from './hero.js';
import { craftView, craftVerdict, initialCraftState } from './craft.js';
import { craftWeapon, fullJournal } from '../formulas/craft.js';
import {
  respecView, questsView, socketsView, bindView, masteryTreeView, itemMenuView, itemTipsView, paperdollEquipView, materialsView, forgeBenchView, shopView,
  exchangeView,
} from './town.js';
import {
  runPortalView, runSegmentView, runReforgeView, runReforgeHead, runMapPanelView, runMapLegendNote, runMapLegend, RUN_MAP_GEOM, runVoteQuestion, runDeathFrame,
} from './runViews.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('эталон моделей окон для Unity (виды сервера)', () => {
  it('пишет __golden__/unity_views.json', () => {
    const cfg = new ConfigRegistry();
    cfg.loadAll();
    const cls = cfg.get('classes').find((c) => c.enabled !== false) ?? cfg.get('classes')[0]!;
    const save = newCharacterSave(cfg, cls.id, 'Образец', 'char-views-golden');
    // uid стартового набора рождают часы — эталону нужны постоянные
    for (const [slot, it] of Object.entries(save.equipment)) if (it) it.uid = `g-worn-${slot}`;
    save.inventory.forEach((it, i) => { it.uid = `g-start-${i}`; });
    save.unspentAttributePoints = 3;
    save.level = 12;
    save.gold = 5000;
    const live = { hp: 30, mana: 10, stamina: 20 };
    const floor = { area: 'town' as const, depth: 0, difficultyId: cfg.get('difficulties')[0]!.id, challengeLevel: null };

    // ── богатая сумка: вещи разных редкостей, стопки сырья, печати ──
    const rng = createRng(20261029);
    const gen = (forceRarity: 'normal' | 'magic' | 'rare', uid: string): Item => ({
      ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
        dropBias: 0, itemLevel: 12, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity, noUnique: true,
      }, rng),
      uid,
    });
    const bag: Item[] = [gen('normal', 'g-normal'), gen('magic', 'g-magic'), gen('rare', 'g-rare'), gen('rare', 'g-rare2')];
    const mats = cfg.get('craft-materials').filter((m) => m.enabled !== false);
    if (mats[0]) bag.push(materialItem(mats[0], 37, 'g-mat'));
    const sealDefs = cfg.get('seals');
    const tier = sealTiers(cfg)[0];
    if (sealDefs[0] && tier) bag.push(sealItem(sealDefs[0], tier.id, 4, 'g-seal'));
    const inv = cfg.get('balance').inventory;
    for (const it of bag) expect(addToInventory(save.inventory, it, { cols: inv.cols, rows: inv.rows }), `в сумку: ${it.uid}`).toBe(true);
    const stash: AccountStash = { version: 1, tabs: [[]], materials: Object.fromEntries(mats.slice(0, 3).map((m, i) => [m.id, 40 + i * 25])) };
    const worn = Object.values(save.equipment).filter((v): v is Item => !!v);
    // атрибуты с запасом — пупсик скажет «ляжет», а не только отказ; отказ — клеткой не той вещи (`equipWrong`)
    for (const a of ['strength', 'dexterity', 'vitality', 'intelligence'] as const) save.attributes[a] += 120;
    // задания: главное + взятое с доски; скил с гнёздами (ранг 6 — два гнезда), вставка в первом, бинд на ПКМ
    // мастерство: вход вложен — соседи доступны, дальние закрыты, у высоких — замок уровнем
    const mt = cfg.get('mastery-tree');
    if (mt.entryNodes[0]) save.masteries[mt.entryNodes[0]] = 1;
    save.unspentMasteryPoints = 2;
    const board = generateBoard(cfg, createRng(7), 1_790_000_000_000);
    if (board[0]) acceptQuest(save, board[0]);
    ensureMainQuest(cfg, save);
    const active = cfg.get('skill-tree').nodes.find((n) => n.effect.active && !cfg.get('skill-tree').branches.find((b) => b.id === n.branchId)?.classId);
    const insert = cfg.get('skill-inserts').find((i) => i.enabled !== false);
    if (active) {
      save.skills[active.id] = 6;
      save.mouseRight = active.id;
      if (insert) save.sockets = { ...(save.sockets ?? {}), [active.id]: [insert.id, null] };
    }
    const weapon = bag.find((it) => it.slot === 'weapon') ?? bag[0]!;
    const stock = [gen('magic', 'shop-1'), gen('rare', 'shop-2')];

    // ── забег: план и метка ──
    const diff = cfg.get('difficulties')[0]!;
    const biome = cfg.get('biomes').find((b) => b.enabled !== false) ?? cfg.get('biomes')[0]!;
    const plan = generateRunPlan(cfg, { id: 'run-golden', seed: 77, tier: diff.id, biomeId: biome.id, modifiers: [] } as never);
    const access = cfg.get('balance').dungeonAccess;
    const mark = access.portalsAt[0] ?? 3;
    const death1 = runDeathFrame(null, { goldLost: 120, itemsLost: 3, toTown: false });
    const death2 = runDeathFrame(death1.state, { goldLost: 0, itemsLost: 0, toTown: false, status: true, canLeave: true });

    const out = {
      note: 'Образцы моделей окон, которые шлёт сервер (виды `packages/shared/src/views`). Генерит packages/shared/src/views/unityViews.gen.test.ts; сторож Unity — Assets/DM/UI/Tests/ViewsCheck.cs.',
      hero: {
        numbers: heroNumbers(cfg, save, []), master: masterBlock(cfg, save, []), hudInfo: hudInfo(cfg, save, floor),
        xp: xpProgress(save.level, save.xp, cfg.get('balance').xpTable), toggles: [],
      },
      sheet: { blocks: sheetView(cfg, save, [], live, { lastTarget: { name: 'Зомби', accuracy: 40, evade: 20 } }) },
      sheetPending: { blocks: sheetView(cfg, save, [], live, { pending: { strength: 2, vitality: 1 } }) },
      tree: skillTreeView(cfg, save),
      // ── С4: город (`view` → `hero`/`item`/`bench`/`shop`/`exchange`) ──
      town: {
        respec: respecView(cfg, save),
        quests: questsView(save, board),
        sockets: socketsView(cfg, save),
        bind: bindView(cfg, save),
        mastery: masteryTreeView(cfg, save),
        menu: { items: itemMenuView(cfg, save, stash, bag[2]!.uid, true) },
        menuField: { items: itemMenuView(cfg, save, stash, bag[2]!.uid, false) },
        tips: { tips: itemTipsView(cfg, save, [...bag, ...worn]) },
        equip: paperdollEquipView(cfg, save, weapon, 'weapon'),
        equipWrong: paperdollEquipView(cfg, save, weapon, 'boots'),
        materials: materialsView(cfg, stash.materials, save.inventory),
        bench: forgeBenchView(cfg, save, stash, weapon.uid),
        shop: shopView(cfg, save, stash, stock),
        exchange: exchangeView(cfg, save, stash, { from: mats[0]?.id ?? null, to: null }),
      },
      // ── С6: забег (`view` → `portal`/`segment`/`reforge`/`map`; кадры `died`, `voteStart`) ──
      run: {
        portal: runPortalView(cfg, save, {}),
        segment: runSegmentView(cfg, save, { depth: mark, biomeId: biome.id, tierId: diff.id, mayTune: true }, { [`${sealDefs[0]?.id}@${tier?.id}`]: 1 }),
        reforge: (() => { const v = runReforgeView(cfg, save, stash); return { ...v, ...runReforgeHead(cfg, v, true) }; })(),
        map: { ...runMapPanelView(plan, plan.nodes[0]?.id ?? null, access.portalsAt, access.contentCycle), legendNote: runMapLegendNote(access.portalsAt, access.contentCycle), legend: runMapLegend(), r: RUN_MAP_GEOM.r },
        mapEmpty: runMapPanelView(null, null, access.portalsAt, access.contentCycle),
        died: { view: death1.view, dock: death1.dock, opens: death1.opens },
        diedStatus: { view: death2.view, dock: death2.dock, opens: death2.opens },
        question: runVoteQuestion({ kind: 'descend', difficultyId: diff.id, biomeId: biome.id, modifiers: [] }, cfg, {}),
      },
      // ── С5: окно ковки (`view` → `craft`): открытый журнал, сырьё сумки и сундука; второй образец — со скованной вещью в сумке ──
      craft: (() => {
        const journal = fullJournal(cfg);
        const wallet = Object.fromEntries(cfg.get('craft-materials').map((m) => [m.id, 60]));
        const a = initialCraftState(cfg, 'sword');
        const plain = craftView(cfg, { st: a, journal, wallet, gold: save.gold, bag: save.inventory, sketch: true });
        const b = initialCraftState(cfg, 'sword');
        const forged = craftWeapon(cfg, { weaponClass: b.weaponClass, hands: b.hands, parts: structuredClone(b.parts), finish: 0 }, { journal, materialsOn: true, rng: createRng(5) }).item;
        if (forged) b.crafted = { ...forged, uid: 'g-forged' };
        const crafted = craftView(cfg, { st: b, journal, wallet, gold: save.gold, bag: save.inventory, sketch: true, craftedInBag: true });
        return {
          plain: { ...plain, verdict: null },
          crafted: { ...crafted, verdict: b.crafted ? craftVerdict(cfg, b, journal, b.crafted) : null },
        };
      })(),
    };
    expect(out.sheet.blocks.length).toBeGreaterThan(3);
    expect(out.tree.nodes.length).toBeGreaterThan(10);
    expect(out.town.bench, 'верстак по оружию из сумки').not.toBeNull();
    expect(Object.keys(out.town.tips.tips).length).toBeGreaterThan(4);
    expect(out.run.map.nodes.length).toBeGreaterThan(3);
    const file = join(HERE, '__golden__', 'unity_views.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  });
});
