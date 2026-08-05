import { z } from 'zod';
import { ConfigRegistry, configSchemas, allStatKeys, schemeRequirements, type ConfigKey, type FloorAlgoParams, type FloorFeatures } from '@dm/shared';
import { renderField, defaultValue, fieldEnumSources, fieldArrayEnumSources } from './form.js';
import { mountFloorPreview } from './floorPreview.js';
import { renderRoomEditor, type RoomPrefab } from './roomEditor.js';
import { renderSimPage } from './sim.js';
import { renderRunGenPage } from './runGen.js';
import { renderItemGenPage } from './itemGen.js';
import { renderPassiveGraph } from './passiveGraph.js';
import { renderSkillGraphPage } from './skillGraph.js';

/**
 * HTML-редактор конфигов. Страницы по механикам (по одному конфигу на страницу),
 * авто-формы из zod-схем, полный CRUD для массивов, валидация и live-apply в игру
 * (через localStorage-оверрайд + BroadcastChannel). Экспорт/импорт JSON.
 */

const LABELS: Record<ConfigKey, string> = {
  balance: 'Баланс',
  classes: 'Классы',
  'items.base': 'Предметы',
  affixes: 'Аффиксы',
  uniques: 'Уники',
  monsters: 'Монстры',
  'monster-affixes': 'Монстры: аффиксы',
  'monster-behaviors': 'Монстры: поведение ИИ',
  'monster-gear': 'Монстры: экипировка',
  'monster-roles': 'Роли монстров',
  packs: 'Пачки монстров',
  difficulties: 'Сложности',
  biomes: 'Биомы',
  floors: 'Этажи',
  'run-modifiers': 'Модификаторы забега',
  'run-templates': 'Шаблоны забега',
  'item-tiers': 'Предметы: тиры',
  'armor-classes': 'Классы брони',
  'phys-subtypes': 'Физ. подтипы',
  'weapon-weights': 'Веса оружия',
  'damage-kinds': 'Тип урона',
  'magic-subtypes': 'Маг. подтипы',
  debuffs: 'Состояния',
  rarities: 'Редкости',
  'rare-names': 'Имена rare',
  'mastery-tree': 'Дерево мастерства',
  'skill-tree': 'Древо скилов',
  'quests.main': 'Квесты: основные',
  'quests.random': 'Квесты: случайные',
  'room-prefabs': 'Комнаты (префабы)',
};

/**
 * Группы левой навигации — родственные конфиги вместе (свёртываемые секции). Группа задаётся
 * либо плоским `keys`, либо `subs` (2-й уровень: под-заголовок + свои ключи) — например «Боевая
 * система» делится на Урон/Состояния/Защиту.
 */
interface NavGroup {
  title: string;
  keys?: ConfigKey[];
  subs?: { title: string; keys: ConfigKey[] }[];
}
const NAV_GROUPS: NavGroup[] = [
  { title: 'Общее', keys: ['balance', 'classes'] },
  { title: '⚔ Боевая система', subs: [
    { title: 'Урон', keys: ['damage-kinds', 'phys-subtypes', 'magic-subtypes', 'weapon-weights'] },
    { title: 'Состояния', keys: ['debuffs'] },
    { title: 'Защита', keys: ['armor-classes'] },
  ] },
  { title: 'Предметы', keys: ['items.base', 'item-tiers', 'rarities', 'affixes', 'uniques', 'rare-names'] },
  { title: 'Монстры', keys: ['monsters', 'monster-gear', 'monster-affixes', 'monster-behaviors', 'monster-roles', 'packs'] },
  { title: 'Мир', keys: ['biomes', 'floors', 'room-prefabs', 'difficulties', 'run-templates', 'run-modifiers'] },
  { title: 'Скиллы', keys: ['skill-tree', 'mastery-tree'] },
  { title: 'Квесты', keys: ['quests.main', 'quests.random'] },
];
/** Все ключи группы (из плоского `keys` или из подсекций `subs`). */
const groupKeys = (g: NavGroup): ConfigKey[] => (g.subs ? g.subs.flatMap((s) => s.keys) : (g.keys ?? []));
/** Короткие подписи внутри группы (без префикса, он ясен из группы). */
const NAV_SHORT: Partial<Record<ConfigKey, string>> = {
  'item-tiers': 'Тиры', rarities: 'Редкости', 'armor-classes': 'Классы брони', 'phys-subtypes': 'Физ. подтипы', 'weapon-weights': 'Веса оружия', 'damage-kinds': 'Тип урона', 'magic-subtypes': 'Маг. подтипы', debuffs: 'Состояния', 'monster-gear': 'Экипировка', 'monster-affixes': 'Аффиксы', 'monster-behaviors': 'Поведение', 'monster-roles': 'Роли', packs: 'Пачки',
  'skill-tree': 'Древо скилов', 'mastery-tree': 'Мастерства',
  'quests.main': 'Основные', 'quests.random': 'Случайные',
  'run-modifiers': 'Модификаторы забега', 'run-templates': 'Шаблоны забега', 'room-prefabs': 'Комнаты',
  'rare-names': 'Имена rare',
};
/**
 * Подветки конфига `balance` (он один большой плоский объект — режем на тематические срезы ТОЛЬКО
 * для редактора: данные/код игры не трогаем, `balance` остаётся одним объектом). Каждая подветка —
 * своя страница-форма с частью полей (через zod `.pick`). Непокрытые ключи (если появятся новые) —
 * авто-попадают в «Прочее», чтобы ничего не потерялось.
 */
const BALANCE_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Прогрессия и мощь', keys: ['xpTable', 'attributePointsPerLevel', 'skillPointsPerLevel', 'masteryPointsPerLevel', 'passiveRankCostMult', 'power'] },
  { title: 'Бой и физика', keys: ['melee', 'weaponAttrScaling', 'twoHandedPowerMult', 'twoHandReqMult', 'maxTotalRequirement', 'affinityDamageBonus', 'moveSpeedBase', 'collision', 'weight'] },
  { title: 'Монстры', keys: ['monsterXpGrowth', 'championXpMult', 'monsterScaling'] },
  { title: 'Лут', keys: ['loot', 'autoPickup'] },
  { title: 'Экономика', keys: ['forgePrices', 'respecCost', 'passiveRespecCostPct', 'skillRespecCostPerPoint'] },
  { title: 'Инвентарь и сундук', keys: ['inventory', 'stash'] },
  { title: 'Забег, смерть, свет', keys: ['dungeonAccess', 'reconnectGraceSec', 'deathPenalty', 'lighting'] },
];
/** Полный список подветок с авто-«Прочее» из ключей схемы, не попавших ни в одну группу. */
const balanceGroupsFull = (() => {
  const covered = new Set(BALANCE_GROUPS.flatMap((g) => g.keys));
  const all = Object.keys((configSchemas.balance as z.ZodObject<z.ZodRawShape>).shape);
  const extra = all.filter((k) => !covered.has(k));
  return extra.length ? [...BALANCE_GROUPS, { title: 'Прочее', keys: extra }] : BALANCE_GROUPS;
})();

/** Раскрытые группы навигации (переживают перерисовку). */
const expandedNav = new Set<string>(['Предметы']);

const registry = new ConfigRegistry();
registry.loadAll();

// Рабочая копия данных: старт со встроенных дефолтов (мгновенно), затем перекрываем
// АКТУАЛЬНЫМ конфигом с сервера (единая истина) — loadFromServer() после первого render().
const data: Record<string, unknown> = structuredClone(registry.snapshot());

const bc = 'BroadcastChannel' in window ? new BroadcastChannel('dm-config') : null;

let current: ConfigKey = 'balance';
let selectedIndex = 0;
let view: 'config' | 'sim' | 'rungen' | 'itemgen' = 'config';
/** Активная подветка balance (её страница-срез). */
let balanceGroup: string = balanceGroupsFull[0]!.title;

// minTier/maxTier — выпадашки из актуального списка тиров (id из item-tiers).
const tierIds = (): string[] => ((data['item-tiers'] as { id: string }[]) ?? []).map((t) => t.id);
fieldEnumSources.minTier = tierIds;
fieldEnumSources.maxTier = tierIds;
// armorClass / requireArmorClass — выпадашки из конфига классов брони.
const armorClassIds = (): string[] => ((data['armor-classes'] as { id: string }[]) ?? []).map((c) => c.id);
fieldEnumSources.armorClass = armorClassIds;
fieldEnumSources.requireArmorClass = armorClassIds;
// physSub / weight — выпадашки из конфигов физ-подтипов и весов.
fieldEnumSources.physSub = () => ((data['phys-subtypes'] as { id: string }[]) ?? []).map((s) => s.id);
fieldEnumSources.weight = () => ((data['weapon-weights'] as { id: string }[]) ?? []).map((w) => w.id);
// appliesTo / exclude (у аффикса) — мультивыбор токенов типа предмета (вид / грань оружия / слот).
const AFFIX_TARGETS = ['weapon', 'weapon.melee', 'weapon.ranged', 'weapon.physical', 'weapon.magical', 'armor', 'shield', 'jewelry', 'helm', 'chest', 'gloves', 'boots', 'belt', 'offhand', 'ring', 'amulet'];
fieldEnumSources.appliesTo = () => AFFIX_TARGETS;
fieldEnumSources.exclude = () => AFFIX_TARGETS;
// tag (в affix.tagWeights[]) — тот же токен-набор базы: множитель веса по типу базы (PoE2).
fieldEnumSources.tag = () => AFFIX_TARGETS;
// stat (у аффиксов/мультимодов/базовых статов/бафф-зелий) — выпадашка из ВСЕХ статов движка
// (атрибуты + производные, включая вампиризм/on-kill). Один источник — не дрейфует.
fieldEnumSources.stat = () => allStatKeys();
// skillId (у прока «шанс каста при ударе») — выпадашка активных узлов дерева скилов.
fieldEnumSources.skillId = () => ((data['skill-tree'] as { nodes?: { id: string; kind?: string }[] } | undefined)?.nodes ?? []).filter((n) => n.kind === 'active').map((n) => n.id);
// biomeId (в этажах) — выпадашка из конфига биомов.
fieldEnumSources.biomeId = () => ((data['biomes'] as { id: string }[]) ?? []).map((b) => b.id);
// role (у монстра и в составе пачки) — выпадашка из конфига ролей монстров.
fieldEnumSources.role = () => ((data['monster-roles'] as { id: string }[]) ?? []).map((r) => r.id);
// weapon / armor / offhand (экипировка монстра) — выпадашки из monster-gear по виду; '' = без предмета.
const monsterGearOf = (kind: 'weapon' | 'armor' | 'shield') => (): string[] =>
  ['', ...((data['monster-gear'] as { id: string; kind: string }[]) ?? []).filter((g) => g.kind === kind).map((g) => g.id)];
fieldEnumSources.weapon = monsterGearOf('weapon');
fieldEnumSources.armor = monsterGearOf('armor');
fieldEnumSources.offhand = monsterGearOf('shield');
// poseClips (у активного скила) — упорядоченный мультивыбор имён сохранённых поз из редактора поз
// (/api/pose → pe_clips). Несколько имён → в 3D удары чередуются. s_hit_ (спец-удар скила) — вперёд, затем hit_, idle_.
let poseClipNames: string[] = [];
fieldArrayEnumSources.poseClips = () => poseClipNames;
// Нормализация старой конвенции имён (стойка_→idle_, удар_→hit_) — чтобы список совпадал с игрой во время миграции.
const migratePoseName = (n: string): string =>
  n.startsWith('стойка_') ? 'idle_' + n.slice('стойка_'.length) : n.startsWith('удар_') ? 'hit_' + n.slice('удар_'.length) : n;
fetch('/api/pose')
  .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
  .then((d) => {
    if (!d) return;
    const clips = (d['pe_clips'] as { name?: string }[] | undefined) ?? [];
    const names = new Set<string>();
    for (const c of clips) if (c.name) names.add(migratePoseName(c.name));
    const rank = (n: string): number => (n.startsWith('s_hit_') ? 0 : n.startsWith('hit_') ? 1 : n.startsWith('idle_') ? 2 : 3);
    poseClipNames = [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    render();   // перерисовать — если открыт скил, выпадашки поз наполнятся
  })
  .catch(() => { /* сервер недоступен — без источника поз */ });

const app = document.getElementById('app')!;
render();
loadFromServer(); // подтянуть актуальный конфиг с сервера — показать реальные значения

/**
 * Единая истина — серверный конфиг (дефолты + сохранённые правки редактора, персист в БД).
 * Тянем при старте, чтобы в редакторе были РЕАЛЬНЫЕ значения. Сервер недоступен — остаёмся на
 * встроенных дефолтах (править/сохранять нельзя, пока не поднят `npm run dev`).
 */
function loadFromServer(): void {
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((snapshot: Record<string, unknown>) => {
      Object.assign(data, snapshot);
      render();
      setStatus('Загружен актуальный конфиг с сервера.', '#7fd67f');
    })
    .catch(() => setStatus('Сервер недоступен — показаны встроенные дефолты. Запусти `npm run dev`, чтобы править и сохранять.', '#ffb020'));
}

function entryLabel(entry: unknown, i: number): string {
  const e = entry as Record<string, unknown>;
  return (e?.name as string) || (e?.id as string) || (e?.classId as string) || `#${i}`;
}

/** Есть ли у элемента массива поле `field` (объект/дискр. union) — для тумблера enabled. */
function schemaHasField(elemSchema: z.ZodTypeAny, field: string): boolean {
  const def = elemSchema._def;
  if (def.typeName === 'ZodObject') return field in (elemSchema as z.ZodObject<z.ZodRawShape>).shape;
  if (def.typeName === 'ZodDiscriminatedUnion') {
    const raw = def.options;
    const opts = (Array.isArray(raw) ? raw : [...raw.values()]) as z.ZodObject<z.ZodRawShape>[];
    return opts.length > 0 && field in opts[0]!.shape;
  }
  return false;
}

/** Тумблер «активно/неактивно» (●/○) для записи со схемным полем `enabled`. */
function enabledToggle(e: Record<string, unknown>): HTMLElement {
  const off = e.enabled === false;
  const tog = document.createElement('span');
  tog.textContent = off ? '○' : '●';
  tog.title = off ? 'Выключен — включить' : 'Включён — выключить';
  tog.style.cssText = `cursor:pointer;color:${off ? '#8a8a9a' : '#5bd06f'};font-size:15px;line-height:1;flex:0 0 auto`;
  tog.addEventListener('click', (ev) => { ev.stopPropagation(); e.enabled = off; render(); });
  return tog;
}

// ── Дерево-навигация для дискриминированных массивов (items.base) ──────────────
/** Поля пути дерева по виду (Оружие: Класс → Хват [1-руч/2-руч]). */
const TREE_PATH: Record<string, string[]> = {
  weapon: ['weaponClass', 'hands'],
  armor: ['slot', 'armorClass'],
  shield: ['shieldClass'],
  jewelry: ['slot'],
  consumable: [],
};
/** Русские подписи узлов дерева (по ЗНАЧЕНИЯМ сегментов пути). */
const TREE_LABEL: Record<string, string> = {
  weapon: 'Оружие', armor: 'Броня', shield: 'Щиты', jewelry: 'Украшение', consumable: 'Расходники',
  melee: 'Ближнее', ranged: 'Дальнее',
  physical: 'Физический', magical: 'Магический',
  superlight: 'Сверхлёгкое', light: 'Лёгкие', medium: 'Средние', heavy: 'Тяжёлые',
  '1': 'Одноручные', '2': 'Двуручные',
  sword: 'Мечи', axe: 'Топоры', mace: 'Булавы', dagger: 'Кинжалы', spear: 'Копья', halberd: 'Алебарды',
  bow: 'Луки', crossbow: 'Арбалеты', wand: 'Жезлы', staff: 'Посохи',
  helm: 'Шлемы', chest: 'Нагрудники', gloves: 'Перчатки', boots: 'Сапоги', belt: 'Пояса',
  ring: 'Кольца', amulet: 'Амулеты',
};
/** Подпись узла: статичная карта → имя из конфига классов брони → сырой id. */
const treeLabel = (seg: string): string =>
  TREE_LABEL[seg] ?? (data['armor-classes'] as { id: string; name: string }[] | undefined)?.find((c) => c.id === seg)?.name ?? seg;

/** Раскрытые узлы дерева (переживают перерисовку). */
const expandedTree = new Set<string>();

interface TreeNode { children: Map<string, TreeNode>; leaves: number[]; }

/** Путь узла для записи: [kind, ...поля пути]. */
function treePathOf(e: Record<string, unknown>): string[] {
  const kind = String(e.kind ?? '?');
  return [kind, ...(TREE_PATH[kind] ?? []).map((f) => String(e[f] ?? '—'))];
}

function buildItemTree(arr: unknown[]): TreeNode {
  const root: TreeNode = { children: new Map(), leaves: [] };
  arr.forEach((entry, i) => {
    let node = root;
    for (const seg of treePathOf(entry as Record<string, unknown>)) {
      let child = node.children.get(seg);
      if (!child) { child = { children: new Map(), leaves: [] }; node.children.set(seg, child); }
      node = child;
    }
    node.leaves.push(i);
  });
  return root;
}

function countLeaves(node: TreeNode): number {
  let n = node.leaves.length;
  for (const c of node.children.values()) n += countLeaves(c);
  return n;
}

/** Вариант-схема по значению дискриминатора (для «+ Новая» в категории). */
function variantForKind(unionSchema: z.ZodTypeAny, kind: string): z.ZodObject<z.ZodRawShape> | undefined {
  const raw = unionSchema._def.options;
  const opts = (Array.isArray(raw) ? raw : [...raw.values()]) as z.ZodObject<z.ZodRawShape>[];
  return opts.find((o) => String((o.shape.kind as z.ZodTypeAny)._def.value) === kind);
}

/** Рисует свёртываемое дерево категорий вместо плоского списка. */
function renderItemTree(list: HTMLElement, arr: unknown[]): void {
  const root = buildItemTree(arr);
  // Держим ветку выбранного открытой.
  const sel = arr[selectedIndex] as Record<string, unknown> | undefined;
  if (sel) {
    let key = '';
    for (const seg of treePathOf(sel)) { key = key ? `${key}/${seg}` : seg; expandedTree.add(key); }
  }
  const walk = (node: TreeNode, prefix: string, depth: number): void => {
    for (const [seg, child] of node.children) {
      const key = prefix ? `${prefix}/${seg}` : seg;
      const open = expandedTree.has(key);
      const row = document.createElement('div');
      row.textContent = `${open ? '▾' : '▸'} ${treeLabel(seg)} (${countLeaves(child)})`;
      row.style.cssText = `padding:4px 6px;padding-left:${6 + depth * 14}px;cursor:pointer;font-size:13px;color:#cfd0da;border-radius:4px;font-weight:${depth === 0 ? 600 : 400}`;
      row.addEventListener('click', () => { if (open) expandedTree.delete(key); else expandedTree.add(key); render(); });
      list.appendChild(row);
      if (open) walk(child, key, depth + 1);
    }
    for (const i of node.leaves) {
      const active = i === selectedIndex;
      const e = arr[i] as Record<string, unknown>;
      const off = e?.enabled === false;
      const item = document.createElement('div');
      item.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 6px;padding-left:${6 + depth * 14}px;cursor:pointer;font-size:13px;border-radius:4px;margin:1px 0;background:${active ? '#2f2f40' : 'transparent'};color:${active ? '#fff' : '#aab4c4'};${off ? 'opacity:0.5' : ''}`;
      item.appendChild(enabledToggle(e));
      const lbl = document.createElement('span');
      lbl.textContent = entryLabel(arr[i], i);
      lbl.style.cssText = `flex:1;${off ? 'text-decoration:line-through' : ''}`;
      item.appendChild(lbl);
      item.addEventListener('click', () => { selectedIndex = i; render(); });
      list.appendChild(item);
    }
  };
  walk(root, '', 0);
}

// ── Дерево аффиксов: Префиксы/Суффиксы → тема (по group) → аффиксы ─────────────
const AFFIX_THEME: Record<string, string> = {
  'dmg-min': 'Урон', 'dmg-max': 'Урон', ed: 'Урон', crit: 'Урон', ias: 'Урон',
  'add-fire': 'Стихийный урон', 'add-cold': 'Стихийный урон', 'add-light': 'Стихийный урон', 'add-poison': 'Стихийный урон',
  'def-flat': 'Защита', 'ed-def': 'Защита', life: 'Защита', mana: 'Защита', block: 'Защита', evade: 'Защита', 'hp-regen': 'Защита', 'mana-regen': 'Защита', frw: 'Защита', accuracy: 'Защита',
  str: 'Атрибуты', dex: 'Атрибуты', int: 'Атрибуты', vit: 'Атрибуты', 'all-attr': 'Атрибуты',
  'res-fire': 'Сопротивления', 'res-cold': 'Сопротивления', 'res-light': 'Сопротивления', 'res-poison': 'Сопротивления', 'res-all': 'Сопротивления',
  leech: 'Вампиризм/убийство', 'mana-leech': 'Вампиризм/убийство', 'life-kill': 'Вампиризм/убийство', 'mana-kill': 'Вампиризм/убийство',
  'proc-cast': 'Проки', 'proc-struck': 'Проки',
};
const KIND_LABEL = (a: Record<string, unknown>): string => (a.kind === 'suffix' ? 'Суффиксы' : 'Префиксы');
const affixTheme = (a: Record<string, unknown>): string => AFFIX_THEME[String(a.group ?? '')] ?? 'Прочее';
const THEME_ORDER = ['Урон', 'Стихийный урон', 'Защита', 'Атрибуты', 'Сопротивления', 'Вампиризм/убийство', 'Проки', 'Прочее'];

function renderAffixTree(list: HTMLElement, arr: unknown[]): void {
  // индексы по Префиксы/Суффиксы → тема
  const groups = new Map<string, Map<string, number[]>>();
  arr.forEach((e, i) => {
    const a = e as Record<string, unknown>;
    const kind = KIND_LABEL(a), theme = affixTheme(a);
    let tm = groups.get(kind); if (!tm) { tm = new Map(); groups.set(kind, tm); }
    const arr2 = tm.get(theme) ?? []; arr2.push(i); tm.set(theme, arr2);
  });
  // ветку выбранного держим открытой
  const sel = arr[selectedIndex] as Record<string, unknown> | undefined;
  if (sel) { expandedTree.add(`affix/${KIND_LABEL(sel)}`); expandedTree.add(`affix/${KIND_LABEL(sel)}/${affixTheme(sel)}`); }

  const leaf = (i: number): void => {
    const a = arr[i] as Record<string, unknown>;
    const off = a?.enabled === false, active = i === selectedIndex;
    const item = document.createElement('div');
    item.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 6px;padding-left:34px;cursor:pointer;font-size:13px;border-radius:4px;margin:1px 0;background:${active ? '#2f2f40' : 'transparent'};color:${active ? '#fff' : '#aab4c4'};${off ? 'opacity:0.5' : ''}`;
    item.appendChild(enabledToggle(a));
    const lbl = document.createElement('span');
    lbl.textContent = entryLabel(arr[i], i);
    lbl.style.cssText = `flex:1;${off ? 'text-decoration:line-through' : ''}`;
    item.appendChild(lbl);
    item.addEventListener('click', () => { selectedIndex = i; render(); });
    list.appendChild(item);
  };
  const header = (text: string, key: string, pad: number, bold: boolean): void => {
    const open = expandedTree.has(key);
    const row = document.createElement('div');
    row.textContent = `${open ? '▾' : '▸'} ${text}`;
    row.style.cssText = `padding:4px 6px;padding-left:${pad}px;cursor:pointer;font-size:13px;color:${bold ? '#cfd0da' : '#aab4c4'};border-radius:4px;font-weight:${bold ? 600 : 400}`;
    row.addEventListener('click', () => { if (open) expandedTree.delete(key); else expandedTree.add(key); render(); });
    list.appendChild(row);
  };

  for (const kind of ['Префиксы', 'Суффиксы']) {
    const tm = groups.get(kind); if (!tm) continue;
    const total = [...tm.values()].reduce((s, a) => s + a.length, 0);
    const kKey = `affix/${kind}`;
    header(`${kind} (${total})`, kKey, 6, true);
    if (!expandedTree.has(kKey)) continue;
    for (const theme of [...tm.keys()].sort((a, b) => THEME_ORDER.indexOf(a) - THEME_ORDER.indexOf(b))) {
      const idxs = tm.get(theme)!;
      const tKey = `${kKey}/${theme}`;
      header(`${theme} (${idxs.length})`, tKey, 20, false);
      if (expandedTree.has(tKey)) for (const i of idxs) leaf(i);
    }
  }
}

function render(): void {
  app.innerHTML = '';
  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:16px;flex:1;min-height:0';

  // Навигация по механикам.
  const nav = document.createElement('div');
  nav.style.cssText = 'flex:0 0 200px;display:flex;flex-direction:column;gap:4px;min-height:0;overflow-y:auto;padding-right:4px';

  // Отдельная вкладка-инструмент: симулятор баланса.
  const simBtn = document.createElement('button');
  simBtn.textContent = '🧪 Симулятор';
  simBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'sim' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  simBtn.addEventListener('click', () => { view = 'sim'; render(); });
  nav.appendChild(simBtn);

  // Отдельная вкладка-инструмент: генератор забегов v2 (структура + поклеточный просмотр).
  const runBtn = document.createElement('button');
  runBtn.textContent = '🗺 Забеги v2';
  runBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'rungen' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  runBtn.addEventListener('click', () => { view = 'rungen'; render(); });
  nav.appendChild(runBtn);

  // Отдельная вкладка-инструмент: генератор предметов (песочница дропа).
  const itemGenBtn = document.createElement('button');
  itemGenBtn.textContent = '🎲 Генератор предметов';
  itemGenBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'itemgen' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  itemGenBtn.addEventListener('click', () => { view = 'itemgen'; render(); });
  nav.appendChild(itemGenBtn);

  // Группы страниц — свёртываемые секции. Некрытые ключи (если появятся) — в «Прочее».
  const covered = new Set(NAV_GROUPS.flatMap(groupKeys));
  const extra = (Object.keys(configSchemas) as ConfigKey[]).filter((k) => !covered.has(k));
  const groups: NavGroup[] = extra.length ? [...NAV_GROUPS, { title: 'Прочее', keys: extra }] : NAV_GROUPS;
  for (const g of groups) if (groupKeys(g).includes(current)) expandedNav.add(g.title);
  if (view === 'config' && current === 'balance') expandedNav.add('__balance'); // раскрыть подветки баланса
  // Кнопка-ключ страницы (общая для плоских групп и подсекций).
  const keyButton = (key: ConfigKey): void => {
    const b = document.createElement('button');
    b.textContent = NAV_SHORT[key] ?? LABELS[key];
    const active = view === 'config' && key === current;
    b.style.cssText = `text-align:left;padding:6px 10px 6px 22px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${active ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;font-size:13px`;
    b.addEventListener('click', () => { view = 'config'; current = key; selectedIndex = 0; render(); });
    nav.appendChild(b);
  };
  // Ключ `balance` разворачивается в собственные подветки (тематические срезы одного объекта).
  const balanceNav = (): void => {
    const openB = expandedNav.has('__balance');
    const onBalance = view === 'config' && current === 'balance';
    const header = document.createElement('button');
    header.textContent = `${openB ? '▾' : '▸'} ${LABELS.balance}`;
    header.style.cssText = `text-align:left;padding:6px 10px 6px 22px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${onBalance ? '#23232f' : '#1c1c26'};color:#e8e8f0;font-size:13px`;
    header.addEventListener('click', () => { if (openB) expandedNav.delete('__balance'); else expandedNav.add('__balance'); render(); });
    nav.appendChild(header);
    if (!openB) return;
    for (const grp of balanceGroupsFull) {
      const sb = document.createElement('button');
      sb.textContent = grp.title;
      const active = onBalance && balanceGroup === grp.title;
      sb.style.cssText = `text-align:left;padding:5px 10px 5px 36px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${active ? '#3a3a4c' : '#161620'};color:#cfd0da;font-size:12px`;
      sb.addEventListener('click', () => { view = 'config'; current = 'balance'; balanceGroup = grp.title; render(); });
      nav.appendChild(sb);
    }
  };
  for (const g of groups) {
    const open = expandedNav.has(g.title);
    const header = document.createElement('button');
    header.textContent = `${open ? '▾' : '▸'} ${g.title}`;
    header.style.cssText = 'text-align:left;padding:7px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:#16161f;color:#cfd0da;font-weight:600;margin-top:4px';
    header.addEventListener('click', () => { if (open) expandedNav.delete(g.title); else expandedNav.add(g.title); render(); });
    nav.appendChild(header);
    if (!open) continue;
    if (g.subs) {
      // 2-й уровень: под-заголовок подсекции (не кнопка) + её ключи.
      for (const sub of g.subs) {
        const subHead = document.createElement('div');
        subHead.textContent = sub.title;
        subHead.style.cssText = 'padding:6px 10px 2px 16px;font-size:11px;color:#71718a;text-transform:uppercase;letter-spacing:0.04em';
        nav.appendChild(subHead);
        for (const key of sub.keys) keyButton(key);
      }
    } else {
      for (const key of g.keys ?? []) { if (key === 'balance') balanceNav(); else keyButton(key); }
    }
  }

  const page = document.createElement('div');
  page.style.cssText = 'flex:1;min-width:0;min-height:0;overflow-y:auto;padding-right:6px';
  if (view === 'sim') renderSimPage(page, data);
  else if (view === 'rungen') renderRunGenPage(page, data);
  else if (view === 'itemgen') renderItemGenPage(page, data);
  else renderPage(page);

  layout.append(nav, page);
  app.appendChild(layout);
}

function renderPage(page: HTMLElement): void {
  const schema = configSchemas[current] as z.ZodTypeAny;
  const isArray = schema._def.typeName === 'ZodArray';

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:sticky;top:0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 10px;margin-bottom:6px;background:#14141a;border-bottom:1px solid #22222c';
  toolbar.append(
    btn('✔ Применить (тест, локально)', apply, '#2a4a2a'),
    btn('💾 Применить везде (в файл)', applyToFile, '#26406a'),
    btn('⭳ Экспорт', exportJson),
    btn('⭱ Импорт', importJson),
    btn('↺ Сбросить конфиг', resetConfig, '#4a2a2a'),
  );
  page.appendChild(toolbar);

  const status = document.createElement('div');
  status.id = 'status';
  status.style.cssText = 'min-height:18px;font-size:13px;margin-bottom:8px';
  page.appendChild(status);

  // Древо скилов (общее + класс-ветки по селектору) и древо мастерства — визуальные граф-редакторы.
  if (current === 'skill-tree') { renderSkillGraphPage(page, data); return; }
  if (current === 'mastery-tree') { renderPassiveGraph(page, data); return; }

  if (isArray) renderArrayPage(page, schema._def.type as z.ZodTypeAny);
  else if (current === 'balance') renderBalanceGroup(page);
  else {
    page.appendChild(
      renderField(schema, data[current], (v) => {
        data[current] = v;
      }),
    );
  }
}

/** Страница-срез balance: только поля активной подветки (через zod `.pick`), с общим тулбаром. */
function renderBalanceGroup(page: HTMLElement): void {
  const grp = balanceGroupsFull.find((g) => g.title === balanceGroup) ?? balanceGroupsFull[0]!;
  const balanceObj = configSchemas.balance as z.ZodObject<z.ZodRawShape>;
  const mask: Record<string, true> = {};
  for (const k of grp.keys) mask[k] = true;
  const picked = balanceObj.pick(mask as Parameters<typeof balanceObj.pick>[0]);
  const bal = (data.balance ?? {}) as Record<string, unknown>;
  data.balance = bal;

  const title = document.createElement('div');
  title.textContent = `Баланс · ${grp.title}`;
  title.style.cssText = 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 12px';
  page.appendChild(title);
  // renderObject мутирует переданный объект (bal === data.balance) на месте — правки сохраняются.
  page.appendChild(renderField(picked, bal, () => { /* мутация in-place */ }));
}

function renderArrayPage(page: HTMLElement, elemSchema: z.ZodTypeAny): void {
  const arr = (data[current] as unknown[]) ?? [];
  data[current] = arr;

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:start';

  // Список записей + CRUD.
  const list = document.createElement('div');
  const crud = document.createElement('div');
  crud.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  const isUnion = elemSchema._def.typeName === 'ZodDiscriminatedUnion';
  crud.append(
    btn('+ Новая', () => {
      let fresh = defaultValue(elemSchema);
      const sel = arr[selectedIndex] as Record<string, unknown> | undefined;
      // В дереве — новая запись наследует категорию выбранной (kind + путь), чтобы лечь рядом.
      if (isUnion && sel) {
        const kind = String(sel.kind);
        const variant = variantForKind(elemSchema, kind);
        if (variant) {
          const nf = defaultValue(variant) as Record<string, unknown>;
          nf.kind = kind;
          for (const f of TREE_PATH[kind] ?? []) if (sel[f] !== undefined) nf[f] = sel[f];
          fresh = nf;
        }
      }
      arr.push(fresh);
      selectedIndex = arr.length - 1;
      render();
    }),
    btn('Дублировать', () => {
      if (arr[selectedIndex] !== undefined) {
        arr.splice(selectedIndex + 1, 0, structuredClone(arr[selectedIndex]));
        selectedIndex += 1;
        render();
      }
    }),
    btn('Удалить', () => {
      if (arr.length) {
        arr.splice(selectedIndex, 1);
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
      }
    }, '#4a2a2a'),
  );
  list.appendChild(crud);

  const supportsEnabled = schemaHasField(elemSchema, 'enabled');
  // Дискриминированные массивы (items.base) — дерево категорий; аффиксы — Префиксы/Суффиксы→тема; прочие — плоский список.
  if (isUnion) {
    renderItemTree(list, arr);
  } else if (current === 'affixes') {
    renderAffixTree(list, arr);
  } else {
    arr.forEach((entry, i) => {
      const e = entry as Record<string, unknown>;
      const off = supportsEnabled && e.enabled === false;
      const active = i === selectedIndex;
      const item = document.createElement('div');
      item.style.cssText = `display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-radius:4px;margin:2px 0;background:${active ? '#2f2f40' : '#161620'};border:1px solid #2c2c3a;font-size:13px;${off ? 'opacity:0.5' : ''}`;
      if (supportsEnabled) item.appendChild(enabledToggle(e));
      const label = document.createElement('span');
      label.textContent = entryLabel(entry, i);
      label.style.cssText = `flex:1;${off ? 'text-decoration:line-through' : ''}`;
      item.appendChild(label);
      item.addEventListener('click', () => { selectedIndex = i; render(); });
      list.appendChild(item);
    });
  }

  const form = document.createElement('div');
  form.style.cssText = 'min-width:0';
  // Живой превью этажа (только страница «Этажи»): справа рисуется generateFloorParams(algoParams),
  // перерисовывается на изменение любого поля формы.
  let preview: { el: HTMLElement; redraw: () => void } | undefined;
  if (current === 'floors' && arr[selectedIndex] !== undefined) {
    preview = mountFloorPreview(() => {
      const f = (arr[selectedIndex] ?? {}) as { algoParams?: FloorAlgoParams; features?: FloorFeatures };
      return { algo: f.algoParams as FloorAlgoParams, features: f.features, lock: !!f.features?.bossRoom, prefabs: (data['room-prefabs'] as RoomPrefab[]) ?? [] };
    });
  }
  if (arr[selectedIndex] === undefined) {
    form.innerHTML = '<div style="color:#666">Нет записей. Нажмите «+ Новая».</div>';
  } else if (current === 'room-prefabs') {
    // Префабы комнат — рисуем ПО КЛЕТКАМ (свой редактор вместо авто-формы).
    const biomeOpts = ((data['biomes'] as { id: string; name: string }[]) ?? []).map((b) => ({ id: b.id, name: b.name }));
    form.appendChild(renderRoomEditor(arr[selectedIndex] as RoomPrefab, biomeOpts, render));
  } else {
    // Предметы: кнопка авто-заполнения требований по схеме веса/класса (дальше правится вручную в форме ниже).
    if (current === 'items.base') {
      const item = arr[selectedIndex] as { kind?: string; requirements?: unknown };
      if (item && ['weapon', 'armor', 'shield'].includes(item.kind ?? '')) {
        const btn = document.createElement('button');
        btn.textContent = '⚖ Заполнить требования по весу';
        btn.title = 'Проставить requirements по схеме (weapon-weights / armor-classes). Затем можно докрутить вручную ниже.';
        btn.style.cssText = 'margin-bottom:8px;padding:5px 10px;cursor:pointer;border-radius:6px;border:1px solid #3c5a3c;background:#22331f;color:#cfe0d6;font-size:12px';
        btn.addEventListener('click', () => {
          const t2h = (data['balance'] as { twoHandReqMult?: number } | undefined)?.twoHandReqMult ?? 1.6;
          item.requirements = schemeRequirements(item as never, data['weapon-weights'] as never, data['armor-classes'] as never, t2h);
          render();
        });
        form.appendChild(btn);
      }
    }
    form.appendChild(
      renderField(elemSchema, arr[selectedIndex], (v) => {
        arr[selectedIndex] = v;
        preview?.redraw();
      }),
    );
  }

  if (preview) {
    grid.style.gridTemplateColumns = '200px minmax(0,1fr) minmax(0,480px)';
    grid.append(list, form, preview.el);
  } else {
    grid.append(list, form);
  }
  page.appendChild(grid);
}

function setStatus(msg: string, color: string): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.style.color = color;
  }
}

function apply(): void {
  const result = (configSchemas[current] as z.ZodTypeAny).safeParse(data[current]);
  if (!result.success) {
    setStatus('Ошибка валидации: ' + result.error.issues[0]?.message + ' @ ' + result.error.issues[0]?.path.join('.'), '#ff8080');
    return;
  }
  bc?.postMessage({ key: current, value: result.data }); // клиент: мгновенно (вью/тултипы)
  pushToServer({ [current]: result.data }); // сервер: персист в БД + авторитетная игра
  setStatus('Сохранение на сервере (БД, для тестов)…', '#9fb0c0');
}

/**
 * «Применить везде»: пишет правку в ФАЙЛ-ИСТОЧНИК `data/*.json` (dev-роут `/api/dev/config-file`)
 * → попадёт в git и на деплой (в отличие от «Применить (тест)», который кладёт только оверрайд в БД
 * локального сервера). Сервер заодно держит оверрайд, чтобы живой конфиг не откатился до рестарта.
 */
function applyToFile(): void {
  const result = (configSchemas[current] as z.ZodTypeAny).safeParse(data[current]);
  if (!result.success) {
    setStatus('Ошибка валидации: ' + result.error.issues[0]?.message + ' @ ' + result.error.issues[0]?.path.join('.'), '#ff8080');
    return;
  }
  bc?.postMessage({ key: current, value: result.data });
  sendConfig(
    () => fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [current]: result.data }) }),
    'Записано в ФАЙЛ data/*.json (попадёт в git/деплой) и применено к игре. Не забудь закоммитить.',
  );
  setStatus('Запись в файл…', '#9fb0c0');
}

/**
 * Шлёт запрос на dev-роут конфига С АВТО-ПОВТОРОМ. Зачем: dev-сервер крутится под `tsx watch`
 * и перезапускается на каждую правку кода (~1–2 c недоступен) — клик «Применить» может попасть
 * ровно в это окно. Сетевую ошибку/5xx/404 (сервер поднимается) ретраим; 422 (данные не прошли
 * валидацию) — не ретраим, это реальный отказ.
 */
function sendConfig(req: () => Promise<Response>, okMsg: string, attempt = 0): void {
  req()
    .then((r) => {
      if (r.ok) { setStatus(okMsg, '#7fd67f'); return; }
      if (r.status === 422) {
        r.json().then((e: { error?: string }) => setStatus(`Сервер отклонил конфиг: ${e?.error ?? '422'}`, '#ffb020'))
          .catch(() => setStatus('Сервер отклонил конфиг (422).', '#ffb020'));
        return;
      }
      throw new Error(String(r.status)); // 404/5xx — вероятно рестарт, ретраим
    })
    .catch(() => {
      if (attempt < 4) {
        setStatus(`Сервер перезапускается… повтор (${attempt + 1}/4)`, '#9fb0c0');
        setTimeout(() => sendConfig(req, okMsg, attempt + 1), 800);
      } else {
        setStatus('Сервер недоступен — не сохранено. Запусти `npm run dev` и повтори.', '#ffb020');
      }
    });
}

/**
 * Игра серверно-авторитетна, поэтому оверрайд надо доставить именно СЕРВЕРУ (dev-роут
 * `/api/dev/config`, проксируется Vite на :3001) — иначе правки видит только клиент, а
 * статы/бой/лут считает сервер и в игре ничего не меняется. Клиентский путь
 * (BroadcastChannel) оставляем для мгновенного вью/тултипов.
 */
function pushToServer(overrides: Record<string, unknown>): void {
  sendConfig(
    () => fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides) }),
    'Сохранено на сервере (переживёт рестарт) и применено к игре. Balance — сразу; статы монстров/лут — со следующего этажа.',
  );
}

/** Просит сервер удалить оверрайд ключа (сброс к встроенному дефолту, персистентно). */
function resetOnServer(key: string): void {
  sendConfig(() => fetch(`/api/dev/config/${encodeURIComponent(key)}`, { method: 'DELETE' }), 'Сброшено к дефолту на сервере.');
}

function exportJson(): void {
  const blob = new Blob([JSON.stringify(data[current], null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${current}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text);
        const res = (configSchemas[current] as z.ZodTypeAny).safeParse(parsed);
        if (!res.success) {
          setStatus('Импорт отклонён: не проходит валидацию.', '#ff8080');
          return;
        }
        data[current] = res.data;
        selectedIndex = 0;
        render();
        setStatus('Импортировано.', '#7fd67f');
      } catch {
        setStatus('Импорт отклонён: некорректный JSON.', '#ff8080');
      }
    });
  });
  input.click();
}

function resetConfig(): void {
  data[current] = structuredClone((registry.snapshot() as Record<string, unknown>)[current]);
  bc?.postMessage({ key: current, value: data[current] });
  resetOnServer(current); // удалить персистентный оверрайд (сброс к дефолту, переживёт рестарт)
  selectedIndex = 0;
  render();
  setStatus('Сброшено к значениям по умолчанию.', '#cbd');
}

function btn(text: string, onClick: () => void, bg = '#2c2c3a'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = `padding:7px 12px;cursor:pointer;background:${bg};color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:13px`;
  b.addEventListener('click', onClick);
  return b;
}
