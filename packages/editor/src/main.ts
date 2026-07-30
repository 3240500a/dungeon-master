import { z } from 'zod';
import { ConfigRegistry, configSchemas, type ConfigKey } from '@dm/shared';
import { renderField, defaultValue, fieldEnumSources } from './form.js';
import { renderSimPage } from './sim.js';
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
  packs: 'Пачки монстров',
  dungeons: 'Подземелья',
  difficulties: 'Сложности',
  'item-tiers': 'Предметы: тиры',
  'armor-classes': 'Классы брони',
  'phys-subtypes': 'Физ. подтипы',
  'weapon-weights': 'Веса оружия',
  'damage-kinds': 'Тип урона',
  'magic-subtypes': 'Маг. подтипы',
  debuffs: 'Состояния',
  rarities: 'Редкости',
  'mastery-tree': 'Дерево мастерства',
  'skill-tree': 'Древо скилов',
  'quests.main': 'Квесты: основные',
  'quests.random': 'Квесты: случайные',
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
  { title: 'Предметы', keys: ['items.base', 'item-tiers', 'rarities', 'affixes', 'uniques'] },
  { title: 'Монстры', keys: ['monsters', 'monster-affixes', 'packs'] },
  { title: 'Мир', keys: ['dungeons', 'difficulties'] },
  { title: 'Скиллы', keys: ['skill-tree', 'mastery-tree'] },
  { title: 'Квесты', keys: ['quests.main', 'quests.random'] },
];
/** Все ключи группы (из плоского `keys` или из подсекций `subs`). */
const groupKeys = (g: NavGroup): ConfigKey[] => (g.subs ? g.subs.flatMap((s) => s.keys) : (g.keys ?? []));
/** Короткие подписи внутри группы (без префикса, он ясен из группы). */
const NAV_SHORT: Partial<Record<ConfigKey, string>> = {
  'item-tiers': 'Тиры', rarities: 'Редкости', 'armor-classes': 'Классы брони', 'phys-subtypes': 'Физ. подтипы', 'weapon-weights': 'Веса оружия', 'damage-kinds': 'Тип урона', 'magic-subtypes': 'Маг. подтипы', debuffs: 'Состояния', 'monster-affixes': 'Аффиксы', packs: 'Пачки',
  'skill-tree': 'Древо скилов', 'mastery-tree': 'Мастерства',
  'quests.main': 'Основные', 'quests.random': 'Случайные',
};
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
let view: 'config' | 'sim' = 'config';

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

// ── Дерево-навигация для дискриминированных массивов (items.base) ──────────────
/** Поля пути дерева по виду (Оружие: Вес → Тип урона → Тип атаки → Класс). */
const TREE_PATH: Record<string, string[]> = {
  weapon: ['weight', 'damageKind', 'attackType', 'weaponClass'],
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
  sword: 'Мечи', axe: 'Топоры', mace: 'Булавы', dagger: 'Кинжалы', spear: 'Копья',
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
      const item = document.createElement('div');
      item.textContent = entryLabel(arr[i], i);
      item.style.cssText = `padding:4px 6px;padding-left:${6 + depth * 14}px;cursor:pointer;font-size:13px;border-radius:4px;margin:1px 0;background:${active ? '#2f2f40' : 'transparent'};color:${active ? '#fff' : '#aab4c4'}`;
      item.addEventListener('click', () => { selectedIndex = i; render(); });
      list.appendChild(item);
    }
  };
  walk(root, '', 0);
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

  // Группы страниц — свёртываемые секции. Некрытые ключи (если появятся) — в «Прочее».
  const covered = new Set(NAV_GROUPS.flatMap(groupKeys));
  const extra = (Object.keys(configSchemas) as ConfigKey[]).filter((k) => !covered.has(k));
  const groups: NavGroup[] = extra.length ? [...NAV_GROUPS, { title: 'Прочее', keys: extra }] : NAV_GROUPS;
  for (const g of groups) if (groupKeys(g).includes(current)) expandedNav.add(g.title);
  // Кнопка-ключ страницы (общая для плоских групп и подсекций).
  const keyButton = (key: ConfigKey): void => {
    const b = document.createElement('button');
    b.textContent = NAV_SHORT[key] ?? LABELS[key];
    const active = view === 'config' && key === current;
    b.style.cssText = `text-align:left;padding:6px 10px 6px 22px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${active ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;font-size:13px`;
    b.addEventListener('click', () => { view = 'config'; current = key; selectedIndex = 0; render(); });
    nav.appendChild(b);
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
      for (const key of g.keys ?? []) keyButton(key);
    }
  }

  const page = document.createElement('div');
  page.style.cssText = 'flex:1;min-width:0;min-height:0;overflow-y:auto;padding-right:6px';
  if (view === 'sim') renderSimPage(page, data);
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
  else {
    page.appendChild(
      renderField(schema, data[current], (v) => {
        data[current] = v;
      }),
    );
  }
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

  // Дискриминированные массивы (items.base) — дерево категорий; прочие — плоский список.
  if (isUnion) {
    renderItemTree(list, arr);
  } else {
    arr.forEach((entry, i) => {
      const item = document.createElement('div');
      item.textContent = entryLabel(entry, i);
      const active = i === selectedIndex;
      item.style.cssText = `padding:6px 8px;cursor:pointer;border-radius:4px;margin:2px 0;background:${active ? '#2f2f40' : '#161620'};border:1px solid #2c2c3a;font-size:13px`;
      item.addEventListener('click', () => {
        selectedIndex = i;
        render();
      });
      list.appendChild(item);
    });
  }

  const form = document.createElement('div');
  if (arr[selectedIndex] !== undefined) {
    form.appendChild(
      renderField(elemSchema, arr[selectedIndex], (v) => {
        arr[selectedIndex] = v;
      }),
    );
  } else {
    form.innerHTML = '<div style="color:#666">Нет записей. Нажмите «+ Новая».</div>';
  }

  grid.append(list, form);
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
