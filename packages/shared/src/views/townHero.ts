/**
 * ⭐ ВИДЫ ГЕРОЯ У ГОРОДСКИХ СТОЕК — сервером: сбросы у мастера (атрибуты, мастерства, скилы) и цена следующего ранга узла мастерства,
 * журнал заданий (строки блока и соперник того же шаблона), сборка скилов (гнёзда и вставки), панель биндов (гейт оружия).
 *
 * Заменяет C# `DmTown.AttrRespecRefund`, `RespecRefusal`, `RanksOf`, `SkillRespecFee`, `PassiveRespecFee`, `PassiveNodeCost`
 * (MasterPanel.cs, SkillsPanel.cs, DmTree.cs), `QuestLines`, `QuestRival` (QuestsPanel.cs), `SocketNodes`, `SocketsOpen`, `InsertById`,
 * `InsertRank`, `InsertTypeName`, `InsertFits`, `ResolveSockets`, `PriceText`, `PoolShort`, `SocketOptions` (SkillsPanel.cs),
 * `SkillFits`, `IsAttackLike`, `ElementOf`, `Abbrev` (DmBindBar.cs). Правила — @dm/shared (`skillRespecFee`, `passiveRespecFee`,
 * `respecRefusal`, `attrRespecRefund`, `respecSkills`/`respecPassives` пробным прогоном, `questRival`, `socketsOpen`, `insertRank`,
 * `insertUnlocked`, `insertFits`, `resolveActive`, `skillWeaponAllowed`, `abilityElementOf`); строки — веб `questLogPanel.ts`,
 * `socketsView.ts`, `bindBar.ts`, `skillIcon.ts`.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { QuestDef, QuestProgress, SaveState, SkillNode } from '../types/index.js';
import {
  attrRespecRefund, passiveAllocCheck, passiveRespecFee, respecPassives, respecRefusal, respecSkills, skillRespecFee,
} from '../economy/townActions.js';
import { questRival } from '../economy/questLogic.js';
import { insertFits, resolveActive, socketsOpen } from '../session/inserts.js';
import { abilityElementOf } from '../session/session.js';
import { insertCooldownMult } from '../formulas/buffTiming.js';
import { skillWeaponAllowed } from '../formulas/skills.js';

// ── сбросы и узел мастерства ─────────────────────────────────────────────────
/** Вложенные ранги (Σ положительных) — «вернёт N очк.» у сбросов скилов и мастерства (C# `RanksOf`). */
export function ranksOf(alloc: Record<string, number> | undefined): number {
  let n = 0;
  for (const r of Object.values(alloc ?? {})) if (r > 0) n += r;
  return n;
}
/**
 * ⚠ Цена следующего ранга узла мастерства — выражение `allocPassive` (townActions.ts: `Math.round(amount * mult ** rank)`). Отдельной
 * функции у ядра нет; это копия ОДНОЙ строки, и тест (`townHero.test.ts`) сверяет её с `allocPassive` на границе `maxGold`.
 * Интегратору: вынести выражение в townActions (`passiveNodeCost`) и звать его в `allocPassive` и здесь.
 */
export function passiveNodeCost(amount: number, rank: number, mult: number): number {
  return Math.round(amount * Math.pow(mult, rank));
}

/** Комиссии сбросов (только `skills` / `masteries` сейва): то, что уйдёт `maxGold`. */
export interface RespecFees { skills: { ranks: number; fee: number }; masteries: { ranks: number; fee: number } }
export function respecFees(reg: ConfigRegistry, save: Pick<SaveState, 'skills' | 'masteries'>): RespecFees {
  return {
    skills: { ranks: ranksOf(save.skills), fee: skillRespecFee(reg, save as SaveState) },
    masteries: { ranks: ranksOf(save.masteries), fee: passiveRespecFee(reg, save as SaveState) },
  };
}

/** Пробный прогон команды на копии сейва: её же отказ (или `null` — исполнится). */
function dryRun(save: SaveState, run: (s: SaveState) => { ok: boolean; reason?: string }): string | null {
  const r = run(structuredClone(save));
  return r.ok ? null : r.reason ?? 'нельзя';
}

/**
 * Окно мастера и кнопки сбросов (новый DTO `RespecView`): атрибуты — цена (`balance.respecCost`, → `maxGold`), сколько очков вернёт,
 * почему нельзя (`respecRefusal` — тот же порядок проверок, что у `respec`); скилы и мастерства — ранги, комиссия (→ `maxGold`) и отказ
 * пробным прогоном самой команды; узлы мастерства — цена следующего ранга (→ `maxGold` команды `allocPassive`).
 */
export interface RespecView {
  attrs: { cost: number; refund: number; refusal: string | null };
  skills: { ranks: number; fee: number; refusal: string | null };
  masteries: { ranks: number; fee: number; refusal: string | null };
  /** id узла мастерства (стоимость золотом) → цена следующего ранга. */
  nodeCosts: Record<string, number>;
}
export function respecView(reg: ConfigRegistry, save: SaveState): RespecView {
  const fees = respecFees(reg, save);
  const cost = reg.get('balance').respecCost;
  const mult = reg.get('balance').passiveRankCostMult;
  const nodeCosts: Record<string, number> = {};
  for (const n of reg.get('mastery-tree').nodes) if (n.cost.type === 'gold') nodeCosts[n.id] = passiveNodeCost(n.cost.amount, save.masteries[n.id] ?? 0, mult);
  return {
    attrs: { cost, refund: attrRespecRefund(reg, save), refusal: respecRefusal(reg, save, cost) },
    skills: { ...fees.skills, refusal: dryRun(save, (s) => respecSkills(reg, s, fees.skills.fee)) },
    masteries: { ...fees.masteries, refusal: dryRun(save, (s) => respecPassives(reg, s, fees.masteries.fee)) },
    nodeCosts,
  };
}

// ── задания ──────────────────────────────────────────────────────────────────
/** Строки блока задания (C# кортеж `(status, objectives, reward)` → DTO `QuestLines`). */
export interface QuestLines { status: string; objectives: string[]; reward: string }
export function questLines(def: QuestDef, prog: Pick<QuestProgress, 'status' | 'counters'> | null | undefined): QuestLines {
  const r = def.reward;
  return {
    status: prog?.status === 'completed' ? 'выполнено' : prog?.status === 'turned-in' ? 'сдано' : '',
    objectives: def.objectives.map((obj) => `• ${obj.type}${obj.target ? ` ${obj.target}` : ''}: ${prog?.counters[obj.id] ?? 0}/${obj.amount}`),
    reward: [r.gold && `${r.gold} зол.`, r.xp && `~${Math.round(r.xp / 10)}% ур. опыта`, r.skillPoints && `${r.skillPoints} очк.`, r.itemBaseId && 'предмет']
      .filter(Boolean).join(', '),
  };
}
/** Соперник того же шаблона (C# кортеж `(questId, name, progress)?` → DTO `QuestRival`; нет — `null`). */
export interface QuestRival { questId: string; name: string; progress: string }
/** ⭐ С4: `canTurnIn` — задание выполнено и не сдано (то же условие, что у `turnInQuest`): кнопка «Забрать награду» — по нему, не по сейву. */
export interface QuestEntry extends QuestLines { questId: string; name: string; description: string; rival: QuestRival | null; canTurnIn: boolean }
/**
 * ⭐ ЖУРНАЛ ЗАДАНИЙ (новый DTO `QuestsView`): активные (не сданные, с определением) — строки по прогрессу; доска — строки без прогресса и
 * соперник (`questRival`: «взять — прежнее пропадёт»; согласие уходит флагом `replace` команды `acceptQuest`).
 */
export interface QuestsView { active: QuestEntry[]; board: QuestEntry[] }
export function questsView(save: SaveState, board: readonly QuestDef[]): QuestsView {
  const entry = (def: QuestDef, prog: QuestProgress | null, rival: QuestRival | null): QuestEntry =>
    ({ questId: def.id, name: def.name, description: def.description, ...questLines(def, prog), rival, canTurnIn: prog?.status === 'completed' });
  const active: QuestEntry[] = [];
  for (const q of save.quests) {
    if (q.status === 'turned-in') continue;
    const def = save.activeQuestDefs.find((d) => d.id === q.questId);
    if (def) active.push(entry(def, q, null));
  }
  return { active, board: board.map((d) => entry(d, null, questRival(save, d) ?? null)) };
}

// ── сборка скилов (гнёзда) ───────────────────────────────────────────────────
const POOL_SHORT: Record<'mana' | 'stamina', string> = { mana: 'маны', stamina: 'выносл.' };
/** Пул словом (C# `PoolShort`). */
export const poolShort = (pool: string | undefined): string => (pool === 'mana' || pool === 'stamina' ? POOL_SHORT[pool] : 'undefined');
/** Ценник вставки словом (C# `PriceText`, веб `socketsView.priceText`). */
export function priceText(ins: { cost: number; costPool?: 'carrier' | 'mana' | 'stamina' }, carrier?: 'mana' | 'stamina'): string {
  if (!ins.cost) return 'бесплатно';
  const pool = (ins.costPool ?? 'carrier') === 'carrier' ? carrier : ins.costPool;
  return `${ins.cost > 0 ? '+' : ''}${ins.cost} ${pool ? POOL_SHORT[pool as 'mana' | 'stamina'] : 'ресурса скила'}`;
}

/** ⭐ С4: подсказка вставки — имя, описание и множитель отката на ранге героя (`insertCooldownMult`, та же формула, что у боя). */
export interface InsertTip { name: string; desc: string; cooldownMult: number }
/** Вариант для гнезда (C# кортеж `(label, insertId)` → DTO `{ label, insertId, price, tip }`); `insertId: null` — «✕ Вынуть». */
export interface SocketOption { label: string; insertId: string | null; price: string | null; tip: InsertTip | null }
export interface SocketCell {
  head: string;
  text: string;
  /** Ценник вставки в гнезде; пусто — `null`. */
  price: string | null;
  /** Вставка в гнезде (для подсказки: имя, описание, откат — из конфига) и её ранг. */
  insertId: string | null;
  rank: number;
  /** Подсказка вставки в гнезде; пусто — `null`. */
  tip: InsertTip | null;
  options: SocketOption[];
}
/** C# `DmTown.SocketSummary` — итог сборки (`resolveActive`): те же числа, что посчитает сервер. */
/** ⭐ С4: `resourceText`/`extraPoolText` — пулы словом («маны», «выносл.»): своего словаря у окна нет. */
export interface SocketSummary {
  baseCost: number; cost: number; baseCd: number; cd: number; resource: string; extraPool: string | null; extraAmount: number; procs: number;
  resourceText: string; extraPoolText: string | null;
}
/** ⭐ С4: `element` — стихия скила (цвет обводки гнезда), то же правило, что у бинда. */
export interface SocketNodeView { id: string; name: string; element: string; open: number; filled: number; label: string; cells: SocketCell[]; summary: SocketSummary | null }
/** Новый DTO `SocketsView`: выученные активки с открытыми гнёздами (в порядке древа); нет ни одной — подсказка. */
export interface SocketsView { learned: SocketNodeView[]; hint: string | null }

/**
 * Выученные активки с открытыми гнёздами (в порядке древа) — то, что перечисляет `socketsView`. ⭐ С-аудит (29.10): их же число — цена вида
 * `hero/sockets` в лимите видов (`Room.viewCost`): работа и байты ответа растут с ним, а не с запросом.
 */
export function socketNodes(reg: ConfigRegistry, save: SaveState): ConfigShapes['skill-tree']['nodes'] {
  return reg.get('skill-tree').nodes.filter((n) => n.effect.active && socketsOpen(reg, save.skills[n.id] ?? 0) > 0);
}

type SkillInsertRow = ConfigShapes['skill-inserts'][number];

export function socketsView(reg: ConfigRegistry, save: SaveState): SocketsView {
  const tree = reg.get('skill-tree');
  // ⭐ С-аудит (29.10): ВИД ЛИНЕЙНЫЙ. Раньше каждая клетка перебирала все вставки и на каждую звала `insertUnlocked` и `tipOf`, а те —
  // `insertRank`, который проходит ВСЁ древо (455 узлов): поздний билд (≈ 74 активки) — 5–8 мс и 130–200 КБ за запрос ценой в 1 токен.
  // Теперь древо проходится ОДИН раз (ранг каждой вставки — максимум по донорам, как `insertRank`), имена типов и вставки — словарями
  // (первая строка с id, как `find`), открытые вставки — списком в порядке конфига, подсказка — одна на вставку. Ответ — байт в байт прежний
  // (сторож — `townHero.sockets.test.ts`: прежний перебор против нового на больших сборках).
  const rankOf = new Map<string, number>();
  for (const n of tree.nodes) {
    const g = n.effect.grantsInsert;
    if (g) rankOf.set(g, Math.max(rankOf.get(g) ?? 0, save.skills[n.id] ?? 0));
  }
  const rank = (id: string): number => rankOf.get(id) ?? 0;
  const typeNames = new Map<string, string>();
  for (const t of reg.get('skill-insert-types')) if (!typeNames.has(t.id)) typeNames.set(t.id, t.name);
  const typeName = (id: string): string => typeNames.get(id) ?? id;
  const inserts = reg.get('skill-inserts');
  const byId = new Map<string, SkillInsertRow>();
  for (const x of inserts) if (!byId.has(x.id)) byId.set(x.id, x);
  // как `insertById`: только включённая
  const insertOf = (id: string): SkillInsertRow | undefined => { const x = byId.get(id); return x?.enabled === false ? undefined : x; };
  // как условия перебора: включена и открыта (`insertUnlocked` — ранг > 0); порядок — конфига
  const unlocked = inserts.filter((x) => x.enabled !== false && rank(x.id) > 0);
  const tips = new Map<SkillInsertRow, InsertTip>();
  const tipOf = (x: SkillInsertRow): InsertTip => {
    let t = tips.get(x);
    if (!t) { t = { name: x.name, desc: x.description, cooldownMult: insertCooldownMult(x.cooldownMult, x.perRank.cooldownDecay, rank(x.id)) }; tips.set(x, t); }
    return t;
  };
  const learned = socketNodes(reg, save);
  const hint = learned.length ? null
    : `Гнёзда открываются рангом скила: ${reg.get('balance').skillSocketRanks.join(' / ')}. Вложите очко в активный скил.`;
  return {
    hint,
    learned: learned.map((n) => {
      const base = n.effect.active!;
      const open = socketsOpen(reg, save.skills[n.id] ?? 0);
      const slots = save.sockets?.[n.id] ?? [];
      const filled = slots.filter(Boolean).length;
      const weaponClass = save.equipment.weapon?.weaponClass;
      // ⚠ Как `socketTarget` сервера: ветка другого класса — ни вставить, ни вынуть (вариантов нет).
      const branch = tree.branches.find((br) => br.id === n.branchId);
      const foreign = !!branch?.classId && branch.classId !== save.classId;
      const r = resolveActive(reg, save, n.id);
      const b = base as { manaCost: number; cooldown: number };
      // что вообще влезает в этого носителя — от клетки не зависит
      const fits = foreign ? [] : unlocked.filter((x) => insertFits(x, base, weaponClass));
      return {
        id: n.id, name: n.name, element: skillElement(n), open, filled, label: `${n.name} ${filled}/${open}`,
        cells: Array.from({ length: open }, (_, i): SocketCell => {
          const cur = slots[i] ?? null;
          const ins = cur ? insertOf(cur) : undefined;
          // ⚠ ОТКЛОНЕНИЕ ОТ ЭТАЛОНА (веб `socketsView` смотрел только открытые гнёзда, `slice(0, open)`): сервер (`socketInsert`) не пускает
          // вставку, чей тип стоит в ЛЮБОМ другом гнезде сейва — и в гнезде за пределом открытых (осталось от прежних порогов
          // `skillSocketRanks`). Вариант, от которого сервер откажет «Вставка этого типа уже стоит в другом гнезде», здесь не предлагается.
          const usedTypes = new Set<string>();
          slots.forEach((id, j) => { if (j !== i && id) { const t = insertOf(id)?.type; if (t) usedTypes.add(t); } });
          const options: SocketOption[] = cur && !foreign ? [{ label: '✕ Вынуть', insertId: null, price: null, tip: null }] : [];
          for (const x of fits) {
            if (x.id === cur || usedTypes.has(x.type)) continue;
            options.push({ label: `${typeName(x.type)} · ${x.name}`, insertId: x.id, price: priceText(x, base.resource), tip: tipOf(x) });
          }
          return {
            head: ins ? typeName(ins.type) : `Гнездо ${i + 1}`,
            text: ins ? `${ins.name} · ${rank(ins.id)}` : '— пусто —',
            price: ins ? priceText(ins, base.resource) : null,
            insertId: ins ? ins.id : null,
            rank: ins ? rank(ins.id) : 0,
            tip: ins ? tipOf(ins) : null,
            options,
          };
        }),
        summary: r ? {
          baseCost: b.manaCost, cost: (r.active as { manaCost: number }).manaCost, baseCd: b.cooldown, cd: (r.active as { cooldown: number }).cooldown,
          resource: r.active.resource, extraPool: r.extraCost?.pool ?? null, extraAmount: r.extraCost?.amount ?? 0, procs: r.procs.length,
          resourceText: poolShort(r.active.resource), extraPoolText: r.extraCost ? poolShort(r.extraCost.pool) : null,
        } : null,
      };
    }),
  };
}

// ── панель биндов ────────────────────────────────────────────────────────────
/**
 * Стихия скила для цвета слота (веб `skillIcon.elementOf`): явная у attack/cast/curse, иначе по abilityId; без активки — «mastery».
 * Не экспортируется: то же правило уже отдаёт `heroText.elementOf` (виды героя) — два экспорта одного имени сломали бы `views/index.ts`.
 */
function skillElement(node: SkillNode | undefined): string {
  const active = node?.effect.active;
  if (!active) return 'mastery';
  if ((active.category === 'attack' || active.category === 'cast' || active.category === 'curse') && active.element) return active.element;
  return abilityElementOf(active.abilityId);
}
/** Две буквы имени скила (без «Мастерство: »). */
export const abbrev = (name: string): string => name.replace(/^Мастерство:\s*/, '').slice(0, 2);

/** Слот бинда (новый DTO `BindSlot`): значок, стихия (цвет), подходит ли надетому оружию, делит ли таймер атаки. */
export interface BindSlot { value: string | null; text: string; element: string | null; fits: boolean; attackLike: boolean }
/** Пункт выпадающего списка бинда: выученная активка (ранг > 0). */
export interface BindOption { id: string; name: string; rank: number; abbrev: string; element: string; fits: boolean }
export interface BindView { slots: BindSlot[]; options: BindOption[] }

/** Подходит ли бинд НАДЕТОМУ оружию (bindBar `skillFits`): атака и пусто — всегда; ауры, стойки, баффы — любое оружие. */
export function bindFits(reg: ConfigRegistry, save: Pick<SaveState, 'equipment'>, value: string | null | undefined): boolean {
  if (!value || value === 'attack') return true;
  const active = reg.get('skill-tree').nodes.find((n) => n.id === value)?.effect.active;
  if (!active || (active.category !== 'attack' && active.category !== 'cast' && active.category !== 'curse')) return true;
  return skillWeaponAllowed(active, save.equipment.weapon, save.equipment.offhand);
}
export function bindSlotView(reg: ConfigRegistry, save: Pick<SaveState, 'equipment'>, value: string | null | undefined): BindSlot {
  const node = value && value !== 'attack' ? reg.get('skill-tree').nodes.find((n) => n.id === value) : undefined;
  return {
    value: value ?? null,
    text: value === 'attack' ? '⚔' : value ? (node ? abbrev(node.name) : '?') : '—',
    element: node ? skillElement(node) : null,
    fits: bindFits(reg, save, value),
    attackLike: value === 'attack' || (!!value && node?.effect.active?.category === 'attack'),
  };
}
/** ⭐ ПАНЕЛЬ БИНДОВ: пять слотов (ЛКМ, ПКМ, три доп.) и список выученных активок для выбора. */
export function bindView(reg: ConfigRegistry, save: SaveState): BindView {
  const values = [save.mouseLeft, save.mouseRight, ...[0, 1, 2].map((i) => save.hotbar[i] ?? null)];
  const options = reg.get('skill-tree').nodes
    .filter((n) => (save.skills[n.id] ?? 0) > 0 && n.effect.active)
    .map((n) => ({ id: n.id, name: n.name, rank: save.skills[n.id]!, abbrev: abbrev(n.name), element: skillElement(n), fits: bindFits(reg, save, n.id) }));
  return { slots: values.map((v) => bindSlotView(reg, save, v)), options };
}

// ── древо мастерства ─────────────────────────────────────────────────────────
/**
 * ⭐ С4 (29.10): УЗЕЛ ДРЕВА МАСТЕРСТВА — сервером. `state`: `alloc` — вложен, `avail` — можно вложить, `level` — доступен по смежности, но закрыт
 * уровнем, `closed` — ни входа, ни вложенного соседа. `cost` — цена следующего ранга (→ `maxGold` команды `allocPassive`), `refusal` — почему
 * команда откажет (то же правило `passiveAllocCheck`, плюс очки и золото), `clickable` — правило самой команды пускает. Подсказка — строкой.
 * Заменяет доступность и подсказку, которые `DmTree.Build` считал по конфигу сам (вход/сосед вложен/`levelReq`, текст модификаторов).
 */
export interface MasteryNode {
  id: string; x: number; y: number; name: string; notable: boolean; entry: boolean; rank: number; maxRank: number;
  state: 'alloc' | 'avail' | 'level' | 'closed'; clickable: boolean; cost: number | null; refusal: string | null; tip: string;
}
export interface MasteryEdge { a: string; b: string; both: boolean }
export interface MasteryTreeView { nodes: MasteryNode[]; edges: MasteryEdge[] }

export function masteryTreeView(reg: ConfigRegistry, save: SaveState): MasteryTreeView {
  const tree = reg.get('mastery-tree');
  const entries = new Set(tree.entryNodes);
  const rankOf = (id: string): number => save.masteries[id] ?? 0;
  const adj = new Map<string, string[]>();
  for (const [a, b] of tree.edges) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const nodes = tree.nodes.map((n): MasteryNode => {
    const rank = rankOf(n.id);
    const near = entries.has(n.id) || (adj.get(n.id) ?? []).some((x) => rankOf(x) > 0);
    const state: MasteryNode['state'] = rank > 0 ? 'alloc' : !near ? 'closed' : save.level < n.levelReq ? 'level' : 'avail';
    const chk = passiveAllocCheck(reg, save, n.id);
    const cost = chk.ok ? chk.cost : null;
    const refusal = !chk.ok ? chk.reason : save.unspentMasteryPoints < 1 ? 'Нет очков мастерства' : save.gold < chk.cost ? 'Недостаточно золота' : null;
    const costLine = n.cost.type !== 'gold' ? '' : rank >= n.maxRank ? ' · макс. ранг' : cost !== null ? ` · след. ранг: ${cost} зол. + 1 очко` : '';
    let tip = `<b>${n.name}</b>
${n.description}
ранг ${rank}/${n.maxRank}${costLine}`;
    if (save.level < n.levelReq) tip += `
<color=#d89b7c>требуется уровень ${n.levelReq}</color>`;
    const eff = (n.effect.modifiers ?? []).map((m) => `${m.kind === 'increased' ? `+${Math.round(m.value * 100)}%` : `+${m.value}`} ${m.stat}`).join(', ');
    if (eff) tip += `
<color=#88ffdd>${eff}</color>`;
    return {
      id: n.id, x: n.x, y: n.y, name: n.name, notable: !!n.notable, entry: entries.has(n.id), rank, maxRank: n.maxRank,
      state, clickable: chk.ok, cost, refusal, tip,
    };
  });
  const edges = tree.edges.map(([a, b]) => ({ a, b, both: rankOf(a) > 0 && rankOf(b) > 0 }));
  return { nodes, edges };
}
