import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { QuestDef, QuestProgress, RandomQuestTemplate } from '../types/quest.js';
import type { Rng } from '../formulas/rng.js';
import { xpForLevel } from '../formulas/xp.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { addToInventory } from '../inventory/grid.js';
import { gainXp } from './progression.js';
import type { ActionResult } from './townActions.js';

/**
 * АВТОРИТЕТНАЯ логика квестов над `SaveState` — чистая, для сервера (клиент лишь
 * отображает `save.quests`/`save.activeQuestDefs` и шлёт команды accept/turnIn). Трекинг
 * прогресса — по событиям сессии (убийство/сбор/этаж) в `Room`. Награда сдачи (золото/
 * опыт-доля/очки/предмет) применяется здесь же. Раньше это делал клиентский QuestController.
 */

/** Опыт за квест как доля уровня: permille — промилле опыта до следующего уровня (80 = 8%). */
export function questXp(level: number, xpTable: number[], permille: number): number {
  const delta = xpForLevel(level + 1, xpTable) - xpForLevel(level, xpTable);
  return Math.round((delta * permille) / 1000);
}

/** Строит конкретный квест из шаблона доски (`uid` — уникальный суффикс id). */
export function questFromTemplate(tpl: RandomQuestTemplate, rng: Rng, uid: string): QuestDef {
  const amount = rng.int(tpl.amountRange[0], tpl.amountRange[1]);
  const target = tpl.targetPool.length ? rng.pick(tpl.targetPool) : undefined;
  const reward = {
    gold: rng.int(tpl.rewardGoldRange[0], tpl.rewardGoldRange[1]),
    xp: rng.int(tpl.rewardXpRange[0], tpl.rewardXpRange[1]),
    itemBaseId: tpl.rewardItemPool?.length ? rng.pick(tpl.rewardItemPool) : undefined,
  };
  const label =
    tpl.objectiveType === 'kill' ? `Уничтожить ${amount} (${target})`
      : tpl.objectiveType === 'reach-floor' ? `Достичь этажа ${amount}`
        : `Собрать ${amount} (${target})`;
  return {
    id: `rnd_${tpl.id}_${uid}`,
    name: label,
    description: 'Случайное задание с доски.',
    objectives: [{ id: 'o1', type: tpl.objectiveType, target, amount }],
    reward,
  };
}

/** Генерирует доску случайных квестов (по одному на ВКЛЮЧЁННЫЙ шаблон). */
export function generateBoard(reg: ConfigRegistry, rng: Rng): QuestDef[] {
  const templates = (reg.get('quests.random') as RandomQuestTemplate[]).filter((t) => (t as { enabled?: boolean }).enabled !== false);
  return templates.map((t, i) => questFromTemplate(t, rng, `${Date.now().toString(36)}${i}`));
}

/** Принимает квест: кладёт def в activeQuestDefs и создаёт запись прогресса. */
export function acceptQuest(save: SaveState, def: QuestDef): ActionResult {
  if (save.quests.some((q) => q.questId === def.id)) return { ok: false, reason: 'Уже принят' };
  save.activeQuestDefs.push(def);
  save.quests.push({
    questId: def.id,
    status: 'active',
    counters: Object.fromEntries(def.objectives.map((o) => [o.id, 0])),
  });
  return { ok: true };
}

/** Выдаёт первый ВКЛЮЧЁННЫЙ main-квест, если цепочка ещё не начата. Возвращает выданный def или null. */
export function ensureMainQuest(reg: ConfigRegistry, save: SaveState): QuestDef | null {
  if (save.quests.some((q) => q.questId.startsWith('main-'))) return null;
  const main = reg.get('quests.main').find((q) => q.enabled !== false) as QuestDef | undefined;
  if (main && acceptQuest(save, main).ok) return main;
  return null;
}

export interface TrackResult {
  /** Сдвинулся ли счётчик (нужен ли SaveUpdate). */
  changed: boolean;
  /** Квесты, ставшие «выполнено» этим событием. */
  completed: string[];
}

function defOf(save: SaveState, questId: string): QuestDef | undefined {
  return save.activeQuestDefs.find((d) => d.id === questId);
}

function markComplete(def: QuestDef, prog: QuestProgress, completed: string[]): void {
  if (prog.status === 'active' && def.objectives.every((o) => (prog.counters[o.id] ?? 0) >= o.amount)) {
    prog.status = 'completed';
    completed.push(def.id);
  }
}

/** Трекинг убийства/сбора по цели (id монстра / базы предмета). */
export function trackObjective(save: SaveState, type: 'kill' | 'collect-item', target: string): TrackResult {
  const completed: string[] = [];
  let changed = false;
  for (const prog of save.quests) {
    if (prog.status !== 'active') continue;
    const def = defOf(save, prog.questId);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== type || obj.target !== target) continue;
      const cur = prog.counters[obj.id] ?? 0;
      if (cur < obj.amount) { prog.counters[obj.id] = cur + 1; changed = true; }
    }
    if (changed) markComplete(def, prog, completed);
  }
  return { changed, completed };
}

/** Трекинг достижения этажа (общий для пати). */
export function trackFloor(save: SaveState, depth: number): TrackResult {
  const completed: string[] = [];
  let changed = false;
  for (const prog of save.quests) {
    if (prog.status !== 'active') continue;
    const def = defOf(save, prog.questId);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'reach-floor') continue;
      if (depth >= obj.amount && prog.counters[obj.id] !== obj.amount) { prog.counters[obj.id] = obj.amount; changed = true; }
    }
    if (changed) markComplete(def, prog, completed);
  }
  return { changed, completed };
}

export interface TurnInResult extends ActionResult {
  leveled?: boolean;
  /** Следующий квест цепочки, если авто-принят. */
  nextAccepted?: QuestDef | null;
}

/** Сдаёт выполненный квест: выдаёт награду (золото/опыт-доля/очки/предмет), двигает цепочку. */
export function turnInQuest(reg: ConfigRegistry, save: SaveState, questId: string): TurnInResult {
  const prog = save.quests.find((q) => q.questId === questId);
  const def = defOf(save, questId);
  if (!prog || !def) return { ok: false, reason: 'Квест не найден' };
  if (prog.status !== 'completed') return { ok: false, reason: 'Ещё не выполнен' };

  const r = def.reward;
  if (r.gold) save.gold += r.gold;
  if (r.skillPoints) save.unspentSkillPoints += r.skillPoints;
  if (r.itemBaseId) {
    const item = itemFromBaseId(reg.get('items.base'), r.itemBaseId, reg.get('item-tiers'));
    if (item) addToInventory(save.inventory, item, reg.get('balance').inventory);
  }
  const leveled = r.xp
    ? gainXp(save, reg.get('balance'), questXp(save.level, reg.get('balance').xpTable, r.xp)).leveled
    : false;
  prog.status = 'turned-in';

  let nextAccepted: QuestDef | null = null;
  if (def.next) {
    // Идём по цепочке, ПЕРЕПРЫГИВАЯ выключенные квесты (на их `next`), пока не встретим включённый.
    const chain = reg.get('quests.main');
    const seen = new Set<string>();
    let nextId: string | undefined = def.next;
    let next: (typeof chain)[number] | undefined;
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const q = chain.find((x) => x.id === nextId);
      if (!q) break;
      if (q.enabled !== false) { next = q; break; }
      nextId = q.next;
    }
    if (next && acceptQuest(save, next as QuestDef).ok) nextAccepted = next as QuestDef;
  }
  return { ok: true, leveled, nextAccepted };
}
