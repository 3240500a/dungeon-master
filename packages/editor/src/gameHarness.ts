import {
  allocAttr, equip, unequip, allocActive, allocPassive, socketInsert, socketClear, respec, respecSkills, respecPassives, moveInventoryItem, moveToBelt, debuffLabel,
  setBinding, craftAction, enchantAction, sketchAction, forgeSalvage, fieldSalvage, createRng, emptyStash,
  type AccountStash, type SaveState, type TownCommand,
} from '@dm/shared';
import { App } from '@dm/client/core/app.js';
import { GameState } from '@dm/client/core/gameState.js';
import { setItemLabelResolvers } from '@dm/client/modules/inventory/itemView.js';
import { materialNote } from '@dm/client/modules/inventory/materialsModel.js';
import { setDamageTypeMeta } from '@dm/client/core/damageTypes.js';
import { setRarityMeta } from '@dm/client/modules/loot/rarity.js';

/**
 * Мост «редактор → реальная игра»: строит настоящий `App` (@dm/client) + `GameState` из сейва, чтобы
 * калькулятор переиспользовал ПАНЕЛИ игры (стат-блок/паперкукла/атласы) — «одна истина» по статам.
 * Команды панелей (`allocAttr/equip/allocPassive/…`) применяются ТЕМИ ЖЕ функциями `townActions`, что
 * и сервер (одна истина по мутациям), сеть не трогаем. Золото раздуто → билд «свободный» (как d2planner).
 *
 * Кузница — тоже ТЕ ЖЕ действия, что у сервера (`craftAction` / `enchantAction` / `forgeSalvage`), над
 * сундуком `stash` (сырьё + журнал кузнеца): не передан — свой пустой, как у нового аккаунта.
 *
 * ⭐ R7-15: мост — `App` БЕЗ СЕРВЕРА (`offline`): конфиг моста — ровно `data` (песочница — со своими оверрайдами). Раньше
 * конструктор `App` тянул `/api/config` и через миллисекунды клал серверный конфиг поверх: первый кадр песочницы считал по
 * её данным, следующий клик — по серверу. Правка в редакторе доходит до моста только из данных инструмента (`followHarness`).
 */
export function makeHarness(data: Record<string, unknown>, save: SaveState, onChange: () => void, stash?: AccountStash): App {
  const app = new App({ offline: true });
  app.config.loadAll(data, { cross: false });   // ⭐ R22-01: читатель данных инструмента (правило D4 — у записи)
  harnessData.set(app, JSON.stringify(data));
  refreshResolvers(app);
  save.gold = 9_999_999; // калькулятор не гейтит по золоту (комиссии респеков/аллокаций покрыты)
  const gs = new GameState(save);
  app.state = gs; // сеттер подключает провайдеры дерайва/скиллов из конфига
  gs.hp = gs.derived().maxHp; gs.mana = gs.derived().maxMana; gs.stamina = gs.derived().maxStamina;
  const st = stash ?? emptyStash(app.config);
  app.sendCmd = (cmd: TownCommand, id = app.nextCmdId()): number => {
    const r = applyCmd(app, gs, cmd, st);
    onChange();
    // Ответ — как у сервера: ПОСЛЕ перерисовки (у сервера — после `saveUpdate`), тем же кадром
    // `cmdResult`. Окно, которое ждёт итога (`app.request`), получает его сразу, а не таймаутом.
    app.replies.settle({
      t: 'cmdResult', id, cmd: cmd.cmd, ok: r.ok,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.uid !== undefined ? { uid: r.uid } : {}),
      ...(r.unlocked !== undefined ? { unlocked: r.unlocked } : {}),
      // §15.2: итоговая строка разбора («Получено: … · Каталог: …») — как у сервера (`room.ts` `answer`).
      ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    });
    return id;
  };
  return app;
}

/** R7-15: данные, из которых собран конфиг моста (JSON), — по ним `followHarness` видит, что правка была. */
const harnessData = new WeakMap<App, string>();

/**
 * ⭐ R7-15: правка в редакторе (с «Применить» или без) — в конфиг моста, из ТЕХ ЖЕ данных инструмента. Раньше её приносил
 * канал «Применить», который каждый мост открывал сам: голым значением таблицы (оверрайд песочницы пропадал) и в мосты,
 * брошенные давно. Сейв, панели и сундук моста остаются — пересобирать билд не нужно. `true` — конфиг перечитан.
 */
export function followHarness(app: App, data: Record<string, unknown>): boolean {
  const json = JSON.stringify(data);
  if (harnessData.get(app) === json) return false;
  app.config.loadAll(data, { cross: false });   // ⭐ R22-01: читатель данных инструмента (правило D4 — у записи)
  harnessData.set(app, json);
  refreshResolvers(app);
  return true;
}

/** Итог команды моста — те же поля, что у ответа сервера (`cmdResult`). */
interface HarnessOutcome { ok: boolean; reason?: string; uid?: string; unlocked?: string[]; summary?: string }

/** Бросок моста: не боевой сервер, достаточно разных чисел на каждую команду. */
let harnessSeed = 1;
const harnessRng = (): ReturnType<typeof createRng> => createRng((harnessSeed++ * 2654435761) >>> 0 || 1);

/**
 * Команда моста — ТЕМ ЖЕ ядром, что у сервера (ковка и зачарование — `craftAction` / `enchantAction`),
 * поэтому окно ковки в редакторе и игра не разойдутся.
 */
function applyCmd(app: App, gs: GameState, cmd: TownCommand, stash: AccountStash): HarnessOutcome {
  const reg = app.config, s = gs.save;
  switch (cmd.cmd) {
    case 'craft': return craftAction(reg, s, stash, cmd.nonce, cmd.input, harnessRng(), { maxGold: cmd.maxGold, maxMaterials: cmd.maxMaterials });   // R5-15, R8-14: как сервер
    // §6.2: зачарование тратит и эссенцию — из сумки и кошелька сундука моста, с согласием `maxMaterials`, как сервер.
    case 'forgeEnchant': return enchantAction(reg, s, cmd.uid, cmd.rarity, harnessRng(), cmd.maxGold, stash.materials ?? (stash.materials = {}), cmd.maxMaterials);
    case 'forgeSketch': return sketchAction(reg, stash, cmd.variantId);   // R3-11: то же ядро, что у сервера
    case 'forgeSalvage': return forgeSalvage(reg, s, stash, cmd.uid, harnessRng(), cmd.minYield, cmd.avgYield);   // R8-14, R9-04: как сервер
    case 'salvage': return fieldSalvage(reg, s, cmd.uid, harnessRng(), cmd.minYield, cmd.avgYield);
    case 'allocAttr': return allocAttr(s, cmd.attr, cmd.n);
    case 'equip': return equip(reg, s, cmd.uid, cmd.slot);   // R11-02: вторая рука, как сервер
    case 'unequip': return unequip(reg, s, cmd.slot);
    case 'allocSkill': return allocActive(reg, s, cmd.nodeId);
    case 'socketInsert': return socketInsert(reg, s, cmd.nodeId, cmd.slot, cmd.insertId);
    // ⚠ Бинды применяем ТОЙ ЖЕ `setBinding`, что и сервер. Без них панель биндов в калькуляторе
    // выглядела бы живой и не делала ничего, а строки «Урон (ЛКМ)/(ПКМ)» в стат-листе считаются
    // именно по привязке — то есть главный результат планирования был бы недостижим.
    case 'bind': return setBinding(reg, s, cmd.slot, cmd.value);
    case 'socketClear': return socketClear(reg, s, cmd.nodeId, cmd.slot);
    case 'allocPassive': return allocPassive(reg, s, cmd.nodeId, cmd.maxGold);   // R6-16: как сервер
    case 'respec': return respec(reg, s, cmd.maxGold);
    case 'respecSkills': return respecSkills(reg, s, cmd.maxGold);
    case 'respecPassives': return respecPassives(reg, s, cmd.maxGold);
    case 'moveItem': return moveInventoryItem(reg, s, cmd.uid, cmd.x, cmd.y);
    case 'moveBelt': return moveToBelt(s, cmd.uid);
    case 'drop': { // «выбросить» = просто убрать из билда
      const i = s.inventory.findIndex((it) => it.uid === cmd.uid);
      if (i < 0) return { ok: false, reason: 'Нет предмета' };
      s.inventory.splice(i, 1);
      return { ok: true };
    }
    default: return { ok: false, reason: 'Калькулятор эту команду не исполняет' }; // магазин/квесты ему не нужны
  }
}

function refreshResolvers(app: App): void {
  setItemLabelResolvers({
    armorClass: (id) => app.config.get('armor-classes').find((c) => c.id === id)?.name ?? id,
    weight: (id) => (app.config.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),
    physSub: (id) => { const sub = app.config.get('phys-subtypes').find((x) => x.id === id); return sub ? `${sub.name.toLowerCase()} → ${debuffLabel(app.config.get('debuffs'), sub.kind).toLowerCase()}` : id; },
    skill: (id) => app.config.get('skill-tree').nodes.find((n) => n.id === id)?.name ?? id,
    tierName: (id) => app.config.get('item-tiers').find((t) => t.id === id)?.name,
    materialNote: (item) => materialNote(app.config, item),
  });
  const phys = app.config.get('damage-kinds').find((k) => k.id === 'physical');
  setDamageTypeMeta({
    ...(phys ? { physical: { name: phys.name, short: phys.short, color: phys.color, ailment: null } } : {}),
    ...Object.fromEntries(app.config.get('magic-subtypes').map((s) => [s.id, { name: s.name, short: s.short, color: s.color, ailment: s.ailment }])),
  });
  setRarityMeta(Object.fromEntries(app.config.get('rarities').map((r) => [r.id, { name: r.name, color: r.color }])));
}
