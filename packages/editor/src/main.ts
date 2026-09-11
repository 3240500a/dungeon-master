import { z } from 'zod';
import { ConfigRegistry, configSchemas, allStatKeys, schemeRequirements, type ConfigKey, type FloorAlgoParams, type FloorFeatures } from '@dm/shared';
import { renderField, defaultValue, fieldEnumSources, fieldArrayEnumSources, fieldCustomRenderers, renderEnum } from './form.js';
import { renderSpawnCurve } from './spawnCurveEditor.js';
import { renderDeriveOverride } from './deriveOverrideEditor.js';
import { mountFloorPreview } from './floorPreview.js';
import { renderRoomEditor, type RoomPrefab } from './roomEditor.js';
import { renderSimPage } from './sim.js';
import { renderRunGenPage } from './runGen.js';
import { renderItemGenPage } from './itemGen.js';
import { renderMonsterGenPage } from './monsterGen.js';
import { renderCalcPage } from './calc.js';
import { renderSkillBuildPage } from './skillBuild.js';
import { devFetch } from '@dm/client/devAuth.js';   // инструментальные роуты требуют роли admin
import { renderRoadmapPage } from './roadmap.js';
import { renderSweepPage } from './sweep.js';
import { setEditorNav } from './editorNav.js';
import { renderPassiveGraph } from './passiveGraph.js';
import { renderSkillGraphPage } from './skillGraph.js';
import { renderColorField, renderUploadField, renderBatchUpload, renderMaterialPanel, currentAssetCategory } from './assetFields.js';
import { renderDocs } from './docs.js';

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
  'monster-item-affixes': 'Монстры: аффиксы шмота',
  'monster-behaviors': 'Монстры: поведение ИИ',
  'monster-gear': 'Монстры: экипировка',
  'depth-tiers': 'Монстры: тиры глубины',
  'monster-derive': 'Монстры: деривация статов',
  'monster-roles': 'Роли монстров',
  subfactions: 'Монстры: подфракции',
  'monster-rarity': 'Монстры: редкость (кол-во предметов)',
  'monster-uniques': 'Монстры: имена уникальных',
  packs: 'Пачки монстров',
  difficulties: 'Сложности',
  biomes: 'Биомы',
  floors: 'Этажи',
  'run-modifiers': 'Модификаторы забега',
  'run-templates': 'Шаблоны забега',
  'item-tiers': 'Предметы: тиры',
  'craft-materials': 'Предметы: материалы крафта',
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
  'skill-insert-types': 'Вставки: типы',
  'skill-inserts': 'Вставки в скилы',
  'quests.main': 'Квесты: основные',
  'quests.random': 'Квесты: случайные',
  'room-prefabs': 'Комнаты (префабы)',
  textures: '3D: текстуры',
  materials: '3D: материалы',
  models: '3D: меши',
  environment: 'Окружение (фейд)',
  objects: 'Объекты',
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
  { title: 'Предметы', keys: ['items.base', 'item-tiers', 'craft-materials', 'rarities', 'affixes', 'uniques', 'rare-names'] },
  { title: 'Монстры', keys: ['monsters', 'monster-gear', 'depth-tiers', 'monster-derive', 'monster-item-affixes', 'monster-affixes', 'monster-behaviors', 'monster-roles', 'subfactions', 'monster-rarity', 'monster-uniques', 'packs'] },
  { title: 'Мир', keys: ['biomes', 'objects', 'environment', 'floors', 'room-prefabs', 'difficulties', 'run-templates', 'run-modifiers'] },
  { title: 'Скиллы', keys: ['skill-tree', 'skill-inserts', 'skill-insert-types', 'mastery-tree'] },
  { title: 'Квесты', keys: ['quests.main', 'quests.random'] },
  { title: '🧊 3D-ассеты', keys: ['models', 'materials', 'textures'] },
];
/** Все ключи группы (из плоского `keys` или из подсекций `subs`). */
const groupKeys = (g: NavGroup): ConfigKey[] => (g.subs ? g.subs.flatMap((s) => s.keys) : (g.keys ?? []));
/** Короткие подписи внутри группы (без префикса, он ясен из группы). */
const NAV_SHORT: Partial<Record<ConfigKey, string>> = {
  'item-tiers': 'Тиры', 'craft-materials': 'Материалы', rarities: 'Редкости', 'armor-classes': 'Классы брони', 'phys-subtypes': 'Физ. подтипы', 'weapon-weights': 'Веса оружия', 'damage-kinds': 'Тип урона', 'magic-subtypes': 'Маг. подтипы', debuffs: 'Состояния', 'monster-gear': 'Экипировка', 'depth-tiers': 'Тиры глубины', 'monster-derive': 'Деривация', 'monster-affixes': 'Аффиксы', 'monster-behaviors': 'Поведение', 'monster-roles': 'Роли', packs: 'Пачки',
  'skill-tree': 'Древо скилов', 'skill-inserts': 'Вставки', 'skill-insert-types': 'Типы вставок', 'mastery-tree': 'Мастерства',
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
  { title: 'Бой и физика', keys: ['melee', 'dodge', 'knockdown', 'weaponAttrScaling', 'twoHandedPowerMult', 'twoHandReqMult', 'maxTotalRequirement', 'affinityDamageBonus', 'moveSpeedBase', 'collision', 'weight'] },
  { title: 'Монстры', keys: ['monsterXpGrowth', 'uniqueXpMult', 'monsterScaling'] },
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
let view: 'config' | 'sim' | 'rungen' | 'itemgen' | 'monstergen' | 'calc' | 'skillbuild' | 'sweep' = 'config';
// Верхняя секция редактора: Игра (конфиги+инструменты) / 3D-эдитор (поз-редактор) / Документация (описания механик).
type Section = 'game' | 'pose' | 'docs' | 'roadmap';
let section: Section = (() => { try { const s = localStorage.getItem('editor_section'); return s === 'pose' || s === 'docs' || s === 'roadmap' ? s : 'game'; } catch { return 'game'; } })();
const setSection = (s: Section): void => { section = s; try { localStorage.setItem('editor_section', s); } catch { /* */ } render(); };
/** Активная подветка balance (её страница-срез). */
let balanceGroup: string = balanceGroupsFull[0]!.title;

// minTier/maxTier — выпадашки из актуального списка тиров (id из item-tiers).
const tierIds = (): string[] => ((data['item-tiers'] as { id: string }[]) ?? []).map((t) => t.id);
fieldEnumSources.minTier = tierIds;
fieldEnumSources.maxTier = tierIds;
// 3D-модель предмета (modelId): выпадашка ФИЛЬТРУЕТСЯ по виду/слоту предмета (parent). '' = база слота / процедурка.
//  • armor  → имена submesh-ВАРИАНТОВ персонаж-атласов (kind='character'), классифицированные в parent.slot
//    (item.modelId = имя submesh; вариант-по-имени в setAtlas). Плюс легаси per-slot part-меши того же слота.
//  • weapon → models kind='weapon' с weaponType===parent.weaponClass (оружие ОБЩЕЕ на всех, per-char только хват).
//  • shield → models kind='weapon' с weaponType==='shield'.
type ModelRow = { id: string; kind?: string; slot?: string; weaponType?: string; slots?: Record<string, string>; classId?: string };
// Имена submesh-ВАРИАНТОВ персонаж-атласов (kind='character'), классифицированные в этот слот атласа, + легаси per-slot part.
// classId (опц.): СКОУП по атласу конкретного персонажа — вернуть сабмеши ТОЛЬКО из атласа с этим classId (для modelByClass:
// у каждого класса выбор мешей из СВОЕГО атласа, не из всех 7×100). Без classId — все атласы (для общего modelId/baseAppearance).
const atlasVariantsForSlot = (slot: string, classId?: string): string[] => {
  const ms = (data['models'] as ModelRow[]) ?? [];
  const variants = new Set<string>();
  for (const m of ms) {
    if (m.kind === 'character' && m.slots && (classId === undefined || m.classId === classId))
      for (const [mesh, sl] of Object.entries(m.slots)) { if (sl === slot) variants.add(mesh); }
    if (classId === undefined && m.kind === 'part' && m.slot === slot) variants.add(m.id);   // легаси per-slot part — только в общем списке
  }
  return [...variants].sort();
};
const modelIdOptions = (parent: Record<string, unknown> | undefined): string[] => {
  const ms = (data['models'] as ModelRow[]) ?? [];
  const pkind = parent?.['kind'];
  if (pkind === 'weapon') {
    const wc = parent?.['weaponClass'];
    return ['', ...ms.filter((m) => m.kind === 'weapon' && (!wc || m.weaponType === wc)).map((m) => m.id)];
  }
  if (pkind === 'shield') return ['', ...ms.filter((m) => m.kind === 'weapon' && m.weaponType === 'shield').map((m) => m.id)];
  if (pkind === 'armor') return ['', ...atlasVariantsForSlot(String(parent?.['slot'] ?? ''))];   // helm/chest/gloves/boots/belt (belt пока без 3D)
  return ['', ...ms.map((m) => m.id)];                              // фолбэк (не должно вызываться: modelId только у weapon/armor/shield)
};
fieldCustomRenderers.modelId = (value, onChange, parent) => renderEnum(modelIdOptions(parent), value == null ? '' : String(value), onChange);
// Базовый 3D-вид класса (пустые слоты): 5 выпадашек по частям тела → submesh-варианты соответствующего слота атласа.
//  Ключ поля 'baseAppearance' уникален (не коллизится с monster-gear helm/… через fieldEnumSources). '' = все submesh слота.
const APPR: [key: string, slot: string, label: string][] = [
  ['hair', 'helm', 'Причёска / шлем'], ['head', 'head', 'Голова'], ['hands', 'gloves', 'Руки / перчатки'],
  ['body', 'chest', 'Броня (тело)'], ['feet', 'boots', 'Сапоги'],
];
fieldCustomRenderers.baseAppearance = (value, onChange) => {
  const v: Record<string, string> = (value && typeof value === 'object') ? { ...(value as Record<string, string>) } : {};
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  for (const [key, slot, label] of APPR) {
    const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
    const lbl = document.createElement('span'); lbl.textContent = label; lbl.style.cssText = 'min-width:130px;color:#aab';
    const sel = renderEnum(['', ...atlasVariantsForSlot(slot)], v[key] ?? '', (nv) => { const s = String(nv ?? ''); if (s) v[key] = s; else delete v[key]; onChange({ ...v }); });
    row.append(lbl, sel); wrap.append(row);
  }
  return wrap;
};
// 3D-модель брони ПО КЛАССУ (modelByClass): выпадашка modelId на КАЖДЫЙ класс, фильтр по слоту брони (parent.slot).
//  '' = использовать общий modelId. Так у каждого класса СВОЯ 3D-броня для этого предмета.
fieldCustomRenderers.modelByClass = (value, onChange, parent) => {
  const slot = String(parent?.['slot'] ?? '');
  const v: Record<string, string> = (value && typeof value === 'object') ? { ...(value as Record<string, string>) } : {};
  const classes = (data['classes'] as { id: string; name?: string }[]) ?? [];
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  if (!classes.length) { wrap.textContent = 'нет классов в конфиге'; return wrap; }
  for (const c of classes) {
    const opts = ['', ...atlasVariantsForSlot(slot, c.id)];   // СКОУП: меши ТОЛЬКО из атласа этого класса (classId === c.id)
    const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
    const noAtlas = opts.length <= 1;   // у класса нет атласа с этим classId → подсказать
    const lbl = document.createElement('span'); lbl.textContent = (c.name ?? c.id) + (noAtlas ? ' ⚠' : ''); lbl.title = noAtlas ? `Нет атласа с classId='${c.id}'. Загрузи атлас в 3D-эдиторе и поставь ему этот ключ.` : ''; lbl.style.cssText = `min-width:110px;color:${noAtlas ? '#c9a24a' : '#aab'}`;
    const sel = renderEnum(opts, v[c.id] ?? '', (nv) => { const s = String(nv ?? ''); if (s) v[c.id] = s; else delete v[c.id]; onChange({ ...v }); });
    row.append(lbl, sel); wrap.append(row);
  }
  return wrap;
};
// Материал брони ПО КЛАССУ (materialByClass): выпадашка материала на КАЖДЫЙ класс. '' = материал сабмеша атласа/дефолт.
//  Материалы глобальны (не скоупятся по атласу) — список из вкладки «Материалы». Накладывается на меш предмета при экипе.
fieldCustomRenderers.materialByClass = (value, onChange) => {
  const v: Record<string, string> = (value && typeof value === 'object') ? { ...(value as Record<string, string>) } : {};
  const classes = (data['classes'] as { id: string; name?: string }[]) ?? [];
  const opts = ['', ...((data['materials'] as { id: string }[]) ?? []).map((m) => m.id)];
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  if (!classes.length) { wrap.textContent = 'нет классов в конфиге'; return wrap; }
  for (const c of classes) {
    const row = document.createElement('label'); row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
    const lbl = document.createElement('span'); lbl.textContent = c.name ?? c.id; lbl.style.cssText = 'min-width:110px;color:#aab';
    const sel = renderEnum(opts, v[c.id] ?? '', (nv) => { const s = String(nv ?? ''); if (s) v[c.id] = s; else delete v[c.id]; onChange({ ...v }); });
    row.append(lbl, sel); wrap.append(row);
  }
  return wrap;
};
// baseMap/bumpMap/maskMap/… (у материала) → id текстуры из вкладки «Текстуры»; '' = без карты.
const textureIds = (): string[] => ['', ...((data['textures'] as { id: string }[]) ?? []).map((t) => t.id)];
for (const k of ['baseMap', 'bumpMap', 'maskMap', 'occlusionMap', 'emissionMap']) fieldEnumSources[k] = textureIds;
// baseColor/emissionColor (материал) → пикер цвета; url (текстура/меш) → поле + аплоад файла.
fieldCustomRenderers.baseColor = (value, onChange) => renderColorField(value, onChange);
fieldCustomRenderers.emissionColor = (value, onChange) => renderColorField(value, onChange);
fieldCustomRenderers.url = (value, onChange, parent) => renderUploadField(value, onChange, parent);
// Объекты мира (objects): role — авто (enum); modelId — выпадашка всех моделей (фолбэк modelIdOptions); materialId —
// материал-override ('' = из GLB); biomes — мультиселект биомов, к которым относится объект.
const materialIds = (): string[] => ['', ...((data['materials'] as { id: string }[]) ?? []).map((m) => m.id)];
fieldEnumSources.materialId = materialIds;
fieldArrayEnumSources.biomes = () => ((data['biomes'] as { id: string }[]) ?? []).map((b) => b.id);
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
// Вставки: тип и id — выбором из списка, а не руками: опечатка в id — это молча неработающая вставка.
fieldEnumSources.type = () => ((data['skill-insert-types'] as { id: string }[]) ?? []).map((t) => t.id);
fieldEnumSources.grantsInsert = () => ((data['skill-inserts'] as { id: string }[]) ?? []).map((i) => i.id);
fieldEnumSources.biomeId = () => ((data['biomes'] as { id: string }[]) ?? []).map((b) => b.id);
// role (у монстра и в составе пачки) — выпадашка из конфига ролей монстров.
fieldEnumSources.role = () => ((data['monster-roles'] as { id: string }[]) ?? []).map((r) => r.id);
// subfaction (у монстра) — выпадашка из конфига подфракций; '' = базовая (без подфракции).
fieldEnumSources.subfaction = () => ['', ...((data['subfactions'] as { id: string }[]) ?? []).map((sf) => sf.id)];
// affixTheme (у подфракции) — теги стихий из маг. подтипов (fire/cold/lightning/poison).
fieldArrayEnumSources.affixTheme = () => ((data['magic-subtypes'] as { id: string }[]) ?? []).map((s) => s.id);
// floors (у пачки монстров) — мультивыбор id этажей из вкладки «Мир → Этажи»; пусто = пачка на всех этажах.
fieldArrayEnumSources.floors = () => ((data['floors'] as { id: string }[]) ?? []).map((f) => f.id);
// weapon / armor(тело) / helm / offhand (экипировка монстра) — выпадашки из monster-gear по виду+слоту; '' = без предмета.
const monsterGearOf = (kind: 'weapon' | 'armor' | 'shield', slot?: 'chest' | 'helm') => (): string[] =>
  ['', ...((data['monster-gear'] as { id: string; kind: string; slot?: string }[]) ?? [])
    .filter((g) => g.kind === kind && (!slot || (g.slot ?? 'chest') === slot)).map((g) => g.id)];
fieldEnumSources.weapon = monsterGearOf('weapon');
fieldEnumSources.armor = monsterGearOf('armor', 'chest');
fieldEnumSources.helm = monsterGearOf('armor', 'helm');
fieldEnumSources.offhand = monsterGearOf('shield');
// spawnCurve (у монстра) — редактор кривой глубины (гибрид авто/ручная); tier берём из соседнего поля.
fieldCustomRenderers.spawnCurve = (value, onChange, parent) =>
  renderSpawnCurve(value, onChange, (parent?.tier as 'weak' | 'medium' | 'strong' | 'boss') ?? 'medium',
    (data['depth-tiers'] as Parameters<typeof renderSpawnCurve>[3]) ?? []);
// derive (у монстра) — переопределение коэффициентов деривации per-моб; авто-заполнение из общей «Деривации».
fieldCustomRenderers.derive = (value, onChange) =>
  renderDeriveOverride(value, onChange, () => (data['monster-derive'] as Record<string, unknown>) ?? {});
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
setEditorNav((v) => { section = 'game'; view = v; render(); }); // мостик: «Симулятор» может открыть «Калькулятор» с билдом бота
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
  // Пачка монстров (нет id/name): подпись = тип комнаты + привязка к этажам (пусто = все).
  if (e?.roomType) {
    const fl = Array.isArray(e.floors) ? (e.floors as string[]) : [];
    const scope = fl.length ? (fl.length <= 2 ? fl.join(', ') : `${fl.length} этажей`) : 'все этажи';
    return `${e.roomType} · ${scope}`;
  }
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

/** Рендер свёртываемого дерева (общий для item/model). labelOf(seg) — подпись узла; enabled-тумблер — только если у записи есть поле enabled. */
function renderTreeNodes(list: HTMLElement, root: TreeNode, arr: unknown[], labelOf: (seg: string) => string): void {
  const walk = (node: TreeNode, prefix: string, depth: number): void => {
    for (const [seg, child] of node.children) {
      const key = prefix ? `${prefix}/${seg}` : seg;
      const open = expandedTree.has(key);
      const row = document.createElement('div');
      row.textContent = `${open ? '▾' : '▸'} ${labelOf(seg)} (${countLeaves(child)})`;
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
      if (e && 'enabled' in e) item.appendChild(enabledToggle(e));   // у мешей нет enabled — тумблер только где есть
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

/** Дерево категорий предметов (items.base) вместо плоского списка. */
function renderItemTree(list: HTMLElement, arr: unknown[]): void {
  const root = buildItemTree(arr);
  const sel = arr[selectedIndex] as Record<string, unknown> | undefined;
  if (sel) { let key = ''; for (const seg of treePathOf(sel)) { key = key ? `${key}/${seg}` : seg; expandedTree.add(key); } }
  renderTreeNodes(list, root, arr, treeLabel);
}

/** Общий билдер дерева по функции пути (сегменты → вложенные узлы, лист = индекс записи). */
function buildTreeFrom(arr: unknown[], pathOf: (e: Record<string, unknown>, i: number) => string[]): TreeNode {
  const root: TreeNode = { children: new Map(), leaves: [] };
  arr.forEach((entry, i) => {
    let node = root;
    for (const seg of pathOf(entry as Record<string, unknown>, i)) {
      let child = node.children.get(seg);
      if (!child) { child = { children: new Map(), leaves: [] }; node.children.set(seg, child); }
      node = child;
    }
    node.leaves.push(i);
  });
  return root;
}

// ── Дерево мешей: Персонажи / Монстры / Оружие / Окружение (биом → тайлсет|наполнение) / Прочее ─────────
const MODEL_CAT_LABEL: Record<string, string> = { characters: '🧍 Персонажи', monsters: '👹 Монстры', weapons: '⚔ Оружие', tiles: '🧱 Тайлы', decor: '🏺 Декор', environment: '🧱 Окружение', misc: '📦 Прочее', tileset: 'Тайлсет', filling: 'Наполнение', '(общий)': '(общий атлас)' };
/** Набор тайла/декора из url (/assets/tiles/<набор>/… → «<набор>»), иначе пусто. */
function modelSetFromUrl(url: unknown): string { return (/\/assets\/(?:tiles|decor)\/([^/]+)\//i.exec(String(url ?? ''))?.[1]) ?? ''; }
/** Путь меша в дереве. Приоритет — ЯВНАЯ category (character/monster/tile/decor/weapon/misc). Легаси без category —
 *  прежняя эвристика по kind + использованию в объектах. */
function modelPathOf(m: Record<string, unknown>, _i: number): string[] {
  const cat = String(m.category ?? ''), id = String(m.id ?? '');
  if (cat === 'character') return ['characters', String(m.classId ?? '') || '(общий)'];
  if (cat === 'monster') return ['monsters', String(m.classId ?? '') || '(общий)'];
  if (cat === 'weapon') return ['weapons', String(m.weaponType ?? '—')];
  if (cat === 'tile') { const s = modelSetFromUrl(m.url); return s ? ['tiles', s] : ['tiles']; }
  if (cat === 'decor') { const s = modelSetFromUrl(m.url); return s ? ['decor', s] : ['decor']; }
  if (cat === 'misc') return ['misc'];
  // ── легаси (category не задан): угадываем ──
  const kind = String(m.kind ?? '');
  if (kind === 'character') {
    const cid = String(m.classId ?? '');
    if (!cid) return ['characters', '(общий)'];
    const isClass = ((data['classes'] as { id: string }[]) ?? []).some((c) => c.id === cid);
    return [isClass ? 'characters' : 'monsters', cid];
  }
  if (kind === 'weapon') return ['weapons', String(m.weaponType ?? '—')];
  const used = ((data['objects'] as { modelId?: string; role?: string; biomes?: string[] }[]) ?? []).filter((o) => o.modelId === id);
  if (used.length) { const o = used[0]!; const biome = o.biomes?.[0] || 'все'; return ['environment', biome, ['floor', 'wall'].includes(String(o.role)) ? 'tileset' : 'filling']; }
  return ['misc'];
}
function modelTreeLabel(seg: string): string {
  if (MODEL_CAT_LABEL[seg]) return MODEL_CAT_LABEL[seg]!;
  const b = (data['biomes'] as { id: string; name: string }[] | undefined)?.find((x) => x.id === seg); if (b) return b.name;
  const c = (data['classes'] as { id: string; name?: string }[] | undefined)?.find((x) => x.id === seg); if (c) return c.name ?? c.id;
  return seg;
}
/** Дерево мешей по типам вместо плоского списка. */
function renderModelTree(list: HTMLElement, arr: unknown[]): void {
  const root = buildTreeFrom(arr, modelPathOf);
  const sel = arr[selectedIndex] as Record<string, unknown> | undefined;
  if (sel !== undefined) { let key = ''; for (const seg of modelPathOf(sel, selectedIndex)) { key = key ? `${key}/${seg}` : seg; expandedTree.add(key); } }
  renderTreeNodes(list, root, arr, modelTreeLabel);
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

/** Оболочка: верхний таб-бар из 3 секций + тело активной секции (Игра / 3D-эдитор / Документация). */
function render(): void {
  app.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.style.cssText = 'flex:0 0 auto;display:flex;gap:6px;margin-bottom:12px;border-bottom:1px solid #2c2c3a;padding-bottom:8px';
  const SECTIONS: { id: Section; label: string }[] = [
    { id: 'game', label: '🎮 Игра' },
    { id: 'pose', label: '🧍 3D-эдитор' },
    { id: 'docs', label: '📖 Документация' },
    { id: 'roadmap', label: '📍 Роадмап' },
  ];
  for (const s of SECTIONS) {
    const b = document.createElement('button');
    b.textContent = s.label;
    const active = section === s.id;
    b.style.cssText = `padding:8px 16px;cursor:pointer;border-radius:8px 8px 0 0;border:1px solid #2c2c3a;border-bottom:none;background:${active ? '#3a3a4c' : '#1c1c26'};color:${active ? '#fff' : '#b8b8c8'};font-weight:600;font-size:14px`;
    b.addEventListener('click', () => setSection(s.id));
    tabs.appendChild(b);
  }
  app.appendChild(tabs);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column';
  app.appendChild(body);
  if (section === 'pose') renderPose(body);
  else if (section === 'docs') renderDocs(body, { gotoConfig });
  else if (section === 'roadmap') renderRoadmapPage(body, data);
  else renderGame(body);
}

/** Секция «Игра» — левый nav (конфиги+инструменты) + страница. */
function renderGame(host: HTMLElement): void {
  host.innerHTML = '';
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

  // Отдельная вкладка-инструмент: генератор мобов (песочница спавна).
  const monGenBtn = document.createElement('button');
  monGenBtn.textContent = '👹 Генератор мобов';
  monGenBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'monstergen' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  monGenBtn.addEventListener('click', () => { view = 'monstergen'; render(); });
  nav.appendChild(monGenBtn);

  // Отдельная вкладка-инструмент: калькулятор персонажа (планировщик, à la d2planner).
  const calcBtn = document.createElement('button');
  calcBtn.textContent = '🧮 Калькулятор';
  calcBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'calc' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  calcBtn.addEventListener('click', () => { view = 'calc'; render(); });
  nav.appendChild(calcBtn);

  // Отдельная вкладка-инструмент: предпросмотр модульного скила (носитель + вставки).
  const buildBtn = document.createElement('button');
  buildBtn.textContent = '🧩 Сборка скила';
  buildBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'skillbuild' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  buildBtn.addEventListener('click', () => { view = 'skillbuild'; render(); });
  nav.appendChild(buildBtn);

  // Отдельная вкладка-инструмент: свипы баланса (хитмап ударов-до-смерти).
  const sweepBtn = document.createElement('button');
  sweepBtn.textContent = '🔥 Свипы';
  sweepBtn.style.cssText = `text-align:left;padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${view === 'sweep' ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;margin-bottom:6px;font-weight:600`;
  sweepBtn.addEventListener('click', () => { view = 'sweep'; render(); });
  nav.appendChild(sweepBtn);

  // (Поз-редактор переехал в верхнюю секцию «3D-эдитор».)

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
  else if (view === 'monstergen') renderMonsterGenPage(page, data);
  else if (view === 'calc') renderCalcPage(page, data);
  else if (view === 'skillbuild') renderSkillBuildPage(page, data);
  else if (view === 'sweep') renderSweepPage(page, data);
  else renderPage(page);

  layout.append(nav, page);
  host.appendChild(layout);
}

/**
 * Поз-редактор вкладкой (iframe). Живёт в клиенте (`pose-editor.html`, Three.js) — тянуть его код в
 * editor-бандл нельзя (тяжёлый), поэтому встраиваем страницу клиента как есть. Сохранения идут через
 * общий серверный `pose_store` (`/api/pose`) — редактор и iframe видят одни и те же клипы/модели.
 * DEV: editor на своём порту (напр. 5174), клиент на 5173 — src на кросс-ориджин 5173.
 * PROD: собранный клиент и редактор на одном origin — относительный `/pose-editor.html`.
 */
function renderPose(host: HTMLElement): void {
  const crossOrigin = location.port && location.port !== '5173';
  const src = crossOrigin ? 'http://localhost:5173/pose-editor.html' : '/pose-editor.html';
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.style.cssText = 'width:100%;height:100%;border:0;border-radius:8px;background:#0f0f16';
  frame.allow = 'fullscreen';
  host.appendChild(frame);
}

/** Deep-link из документации: перейти в секцию «Игра» на конфиг-страницу (опц. подветку balance). */
function gotoConfig(key: string, group?: string): void {
  if (!(key in configSchemas)) return;   // неизвестный ключ в ссылке дока — игнор
  section = 'game'; try { localStorage.setItem('editor_section', 'game'); } catch { /* */ }
  view = 'config'; current = key as ConfigKey; selectedIndex = 0;
  if (key === 'balance' && group) balanceGroup = group;
  render();
}

function renderPage(page: HTMLElement): void {
  const schema = configSchemas[current] as z.ZodTypeAny;
  const isArray = schema._def.typeName === 'ZodArray';

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:sticky;top:0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 10px;margin-bottom:6px;background:#14141a;border-bottom:1px solid #22222c';
  toolbar.append(
    // ⚠ Ф12.6: подпись врала. «Локально» читалось как «в браузере», а кнопка ВСЕГДА писала на СЕРВЕР
    // (оверрайд в БД). Разница между двумя кнопками не в том, где сохраняется, а в том, попадёт ли правка
    // в файл-источник (git/деплой) или останется оверрайдом до сброса.
    btn('✔ Применить на сервере', apply, '#2a4a2a', 'Пишет оверрайд в БД сервера: действует сразу и переживает рестарт, но в файлы data/*.json (git, деплой) НЕ попадёт.'),
    btn('💾 Применить и записать в файл', applyToFile, '#26406a', 'То же плюс запись в data/*.json — правка попадёт в git и на деплой.'),
    btn('🔎 Проверить конфиг', () => { void runValidation(); }, '#3a2f18'),
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

// ── Форма меша по КАТЕГОРИИ: разные наборы полей (тайл ≠ персонаж). Скрытые поля данные СОХРАНЯЮТ (маска pick). ──
const MODEL_COMMON_FIELDS = ['id', 'name', 'url', 'category', 'scale'];   // общие (kind скрыт — задаётся категорией)
const MODEL_CAT_FIELDS: Record<string, string[]> = {
  character: ['classId', 'slots', 'baseAppearance', 'body', 'boneScale', 'boneOffsets', 'base', 'hideHair', 'boneMap', 'submeshMaterials'],
  monster: ['classId', 'slots', 'baseAppearance', 'body', 'boneScale', 'boneOffsets', 'submeshMaterials'],
  weapon: ['weaponType', 'grip', 'submeshMaterials'],
  tile: [],    // пол/стена: только общие — материал из «Объекта», не из меша
  decor: [],   // декор: то же
  misc: ['kind', 'slot', 'base', 'hideHair', 'submeshMaterials'],   // легаси/прочее — полный набор
};
/** Категория меша для формы: ЯВНАЯ category (если валидна), иначе угадываем по kind/использованию в объектах. */
function modelFormCat(m: Record<string, unknown>): keyof typeof MODEL_CAT_FIELDS {
  const cat = String(m.category ?? '');
  if (cat in MODEL_CAT_FIELDS) return cat;
  const kind = String(m.kind ?? '');
  if (kind === 'character') return 'character';
  if (kind === 'weapon') return 'weapon';
  if (((data['objects'] as { modelId?: string }[]) ?? []).some((o) => o.modelId === m.id)) return 'tile';   // используется объектом → окружение
  return 'misc';
}
/** Движковый kind по категории (тайл/декор — part; персонаж/монстр — character; оружие — weapon). */
function kindForCategory(cat: string): string {
  if (cat === 'character' || cat === 'monster') return 'character';
  if (cat === 'weapon') return 'weapon';
  if (cat === 'tile' || cat === 'decor') return 'part';
  return 'part';
}
/** Рендер формы меша с полями только своей категории (тайл — минимум, без персонажных полей). entry мутируется на
 *  месте; перерисовка при смене category → перефильтровать поля + синхронизировать движковый kind. */
function renderModelForm(elemSchema: z.ZodObject<z.ZodRawShape>, entry: Record<string, unknown>, onKindChange: () => void): HTMLElement {
  const prevCat = String(entry.category ?? '');
  const keys = [...MODEL_COMMON_FIELDS, ...MODEL_CAT_FIELDS[modelFormCat(entry)]!].filter((k) => k in elemSchema.shape);
  const mask = Object.fromEntries(keys.map((k) => [k, true]));
  return renderField(elemSchema.pick(mask as Parameters<typeof elemSchema.pick>[0]), entry, (v) => {
    const cat = String((v as Record<string, unknown>).category ?? '');
    if (cat !== prevCat) { if (cat) (v as Record<string, unknown>).kind = kindForCategory(cat); onKindChange(); }   // смена категории → синк kind + перефильтровать поля
  });
}

function renderArrayPage(page: HTMLElement, elemSchema: z.ZodTypeAny): void {
  const arr = (data[current] as unknown[]) ?? [];
  data[current] = arr;

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:start';

  // Список записей + CRUD.
  const list = document.createElement('div');
  const crud = document.createElement('div');
  crud.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px';
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
        apply();   // ПЕРСИСТ удаления на сервер (БД-оверрайд) — иначе на перезагрузке вернётся (редактор грузит /api/config). Для файла/деплоя — «Применить везде».
      }
    }, '#4a2a2a'),
  );
  // Пакетная загрузка: Текстуры/3D — мультивыбор файлов сразу (по записи на файл).
  // onDone = render + apply(): пакетно-загруженные текстуры/модели СРАЗУ персистят на сервер (иначе на перезагрузке пропадут,
  // а материал, что на них ссылается, покажется без карты — «не применился»). Записи валидны (id+url) → apply не отвалит.
  const uploadDone = (): void => { render(); apply(); };
  // Текстуры: тип/sRGB угадываются по имени файла, как делает импортёр Unity. `*_n|_nrm|_norm|normal` → Normal map;
  // карты ДАННЫХ (`_m`/mask/orm/rough/metal/ao) — линейные; остальное (альбедо/эмиссия) — sRGB. Чекбокс форсирует нормалмап.
  if (current === 'textures') crud.appendChild(renderBatchUpload('.png,.jpg,.jpeg,.webp', arr as Record<string, unknown>[], (id, url, fn, forceNormal) => {
    const isNormal = !!forceNormal || /(_n|_nrm|_norm|normal)$/i.test(fn);
    const isData = isNormal || /(_m|_mask|_orm|_rough|_metal|_ao|_s)$/i.test(fn);
    return { id, name: fn, url, type: isNormal ? 'normalMap' : 'default', sRGB: !isData, flipGreenChannel: false, wrapMode: 'repeat', filterMode: 'bilinear', aniso: 4, mipmaps: true, compression: 'normal' };
  }, uploadDone));
  if (current === 'models') crud.appendChild(renderBatchUpload('.glb,.gltf', arr as Record<string, unknown>[], (id, url, fn) => { const cat = currentAssetCategory(); return { id, name: fn, url, category: cat, kind: kindForCategory(cat) }; }, uploadDone));
  // Чистка «хвостов»: убрать записи, у которых нет файла на сервере (+ каскад материалы/объекты). Для 3D-ассетов.
  if (['textures', 'models', 'materials', 'objects'].includes(current)) {
    const clean = btn('🧹 Убрать битые', () => { void pruneDeadAssets(); }, '#3a2f18');
    clean.title = 'Просканировать textures/models: удалить записи без файла на сервере (и каскадно материалы/объекты, что на них ссылаются). Для случая «удалил файлы с диска — почистить ссылки».';
    crud.appendChild(clean);
  }
  list.appendChild(crud);

  const supportsEnabled = schemaHasField(elemSchema, 'enabled');
  // Дискриминированные массивы (items.base) — дерево категорий; аффиксы — Префиксы/Суффиксы→тема; прочие — плоский список.
  if (isUnion) {
    renderItemTree(list, arr);
  } else if (current === 'affixes' || current === 'monster-item-affixes') {
    renderAffixTree(list, arr);
  } else if (current === 'models') {
    renderModelTree(list, arr);   // группировка мешей: Персонажи/Монстры/Оружие/Окружение/Прочее
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
  } else if (current === 'materials') {
    // Материалы — Unity-подобная панель (Base/Metallic+Smoothness/Normal/Emission/Occlusion) вместо авто-формы.
    form.appendChild(renderMaterialPanel(arr[selectedIndex] as Record<string, unknown>, textureIds, () => (data['textures'] as Record<string, unknown>[]) ?? [], (v) => { arr[selectedIndex] = v; render(); }));
  } else if (current === 'models' && elemSchema._def.typeName === 'ZodObject') {
    // Меши — поля ПО КАТЕГОРИИ модели: окружение не показывает персонажные slot/body/boneScale/boneOffsets/grip/… (только id/name/url/kind/scale).
    form.appendChild(renderModelForm(elemSchema as z.ZodObject<z.ZodRawShape>, arr[selectedIndex] as Record<string, unknown>, render));
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
  const publish = (): void => {
    bc?.postMessage({ key: current, value: result.data });
    sendConfig(
      () => devFetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [current]: result.data }) }),
      'Записано в ФАЙЛ data/*.json (попадёт в git/деплой) и применено к игре. Не забудь закоммитить.',
    );
    setStatus('Запись в файл…', '#9fb0c0');
  };
  // Гейт публикации 3D-ассетов: не пускать в файл/деплой битые ссылки без подтверждения (форма проходит zod, а граф
  // ссылок — нет). Прочие секции публикуются как раньше (без сетевой проверки файлов).
  if (['textures', 'models', 'materials', 'objects'].includes(current)) {
    setStatus('Проверка ссылок перед публикацией…', '#9fb0c0');
    void validateConfig().then((issues) => {
      const errs = issues.filter((i) => i.severity === 'error').length;
      if (errs) { setStatus(`Публикация остановлена: ${errs} ошибок ссылок.`, '#ff8080'); showValidationModal(issues, publish); }   // блок только на ошибках; предупреждения не мешают
      else publish();
    });
  } else publish();
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
    () => devFetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides) }),
    'Сохранено на сервере (переживёт рестарт) и применено к игре. Balance — сразу; статы монстров/лут — со следующего этажа.',
  );
}

/** Есть ли файл ассета по url. ТОЛЬКО достоверное отсутствие → false: 404 или HTML-заглушка. Транзиентную ошибку
 *  (сеть/5xx, напр. рестарт dev-сервера) повторяем; если так и не установили отсутствие — считаем «есть» (не даём
 *  ложному негативу заблокировать публикацию / снести живую запись). */
async function assetExists(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // HEAD (не GET!): только заголовки, БЕЗ тела. GET тянул бы весь GLB (15+ МБ); тело мы не читаем, соединение
      // висит под стрим → после 6 таких проверок пул соединений исчерпан и весь чекер зависает. HEAD освобождает сразу.
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (r.status === 404) return false;                                       // точно нет файла
      if (r.ok) return !/text\/html/i.test(r.headers.get('content-type') ?? ''); // 200: не-HTML = есть; HTML-заглушка = нет
      // прочие статусы (5xx…) — неопределённо, ещё попытка
    } catch { /* сеть — ещё попытка */ }
  }
  return true;   // достоверно не опровергли → не помечаем битой
}

/**
 * Убрать «хвосты» удалённых ассетов: сканирует textures/models (файл на сервере), помечает те, у кого файла нет, и
 * КАСКАДНО — материалы (карта → мёртвая текстура) и объекты (modelId/materialId → мёртвые). Показывает список, по
 * подтверждению удаляет из конфига и сохраняет. Решает «удалил файлы с диска, а в редакторе записи остались».
 */
async function pruneDeadAssets(): Promise<void> {
  const textures = (data.textures as Record<string, unknown>[]) ?? [];
  const models = (data.models as Record<string, unknown>[]) ?? [];
  const materials = (data.materials as Record<string, unknown>[]) ?? [];
  const objects = (data.objects as Record<string, unknown>[]) ?? [];
  setStatus('Проверяю файлы ассетов на сервере…', '#9fb0c0');
  const deadTex = new Set<string>();
  for (const t of textures) if (typeof t.url === 'string' && t.url && !(await assetExists(t.url))) deadTex.add(String(t.id));
  const deadModel = new Set<string>();
  for (const m of models) if (typeof m.url === 'string' && m.url && !(await assetExists(m.url))) deadModel.add(String(m.id));
  const MAPS = ['baseMap', 'bumpMap', 'maskMap', 'occlusionMap', 'emissionMap'];
  const deadMat = new Set<string>();
  for (const mm of materials) if (MAPS.some((k) => typeof mm[k] === 'string' && mm[k] && deadTex.has(mm[k] as string))) deadMat.add(String(mm.id));
  const deadObj = new Set<string>();
  for (const o of objects) if ((typeof o.modelId === 'string' && deadModel.has(o.modelId)) || (typeof o.materialId === 'string' && deadMat.has(o.materialId))) deadObj.add(String(o.id));
  const total = deadTex.size + deadModel.size + deadMat.size + deadObj.size;
  if (!total) { setStatus('Битых ссылок нет — все файлы на месте.', '#7fd67f'); return; }
  const lines = [
    deadModel.size ? `Модели (${deadModel.size}): ${[...deadModel].join(', ')}` : '',
    deadTex.size ? `Текстуры (${deadTex.size}): ${[...deadTex].join(', ')}` : '',
    deadMat.size ? `Материалы (${deadMat.size}, каскад): ${[...deadMat].join(', ')}` : '',
    deadObj.size ? `Объекты (${deadObj.size}, каскад): ${[...deadObj].join(', ')}` : '',
  ].filter(Boolean).join('\n');
  if (!confirm(`Удалить записи, у которых нет файла на сервере?\n\n${lines}\n\nМатериалы/объекты убираются каскадно (ссылаются на удалённое).`)) { setStatus('Отменено.', '#9aa'); return; }
  const changed: Record<string, unknown> = {};
  if (deadTex.size) { data.textures = textures.filter((t) => !deadTex.has(String(t.id))); changed.textures = data.textures; }
  if (deadModel.size) { data.models = models.filter((m) => !deadModel.has(String(m.id))); changed.models = data.models; }
  if (deadMat.size) { data.materials = materials.filter((m) => !deadMat.has(String(m.id))); changed.materials = data.materials; }
  if (deadObj.size) { data.objects = objects.filter((o) => !deadObj.has(String(o.id))); changed.objects = data.objects; }
  pushToServer(changed);
  selectedIndex = 0;
  render();
  setStatus(`Убрано битых: ${total} (модели ${deadModel.size}, текстуры ${deadTex.size}, материалы ${deadMat.size}, объекты ${deadObj.size}).`, '#7fd67f');
}

// ── Проверка конфига перед публикацией: перекрёстные ссылки + наличие файлов ассетов ────────────────────
interface ConfigIssue { section: string; id: string; msg: string; severity: 'error' | 'warn' }

/**
 * Валидатор конфига: проверяет, что все перекрёстные ссылки РАЗРЕШАЮТСЯ и файлы ассетов существуют на сервере.
 * Ловит класс багов «ссылка на то, чего нет». Схема (zod) проверяет форму полей, а это — целостность графа ссылок.
 *  - error (жёстко, ломает рендер, блокирует публикацию): url→файл, objects→models/materials, materials→textures,
 *    submeshMaterials→materials.
 *  - warn (мягко, есть грациозный фолбэк): items.base/monster-gear .modelId → нет модели (незалитая шмотка/гир).
 */
async function validateConfig(): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  const arr = (s: string): Record<string, unknown>[] => (Array.isArray(data[s]) ? (data[s] as Record<string, unknown>[]) : []);
  const ids = (s: string): Set<string> => new Set(arr(s).map((x) => String(x.id)));
  const models = ids('models'), materials = ids('materials'), textures = ids('textures');

  // 1) файлы на сервере (textures/models .url) — честный 404 или HTML-заглушка → нет файла [error]
  for (const t of arr('textures')) if (typeof t.url === 'string' && t.url && !(await assetExists(t.url))) issues.push({ section: 'textures', id: String(t.id), msg: `нет файла на сервере: ${t.url}`, severity: 'error' });
  for (const m of arr('models')) if (typeof m.url === 'string' && m.url && !(await assetExists(m.url))) issues.push({ section: 'models', id: String(m.id), msg: `нет файла на сервере: ${m.url}`, severity: 'error' });

  // 2) перекрёстные ссылки id→секция (только если поле задано)
  const ref = (section: string, field: string, target: Set<string>, targetName: string, severity: 'error' | 'warn'): void => {
    for (const e of arr(section)) { const v = e[field]; if (typeof v === 'string' && v && !target.has(v)) issues.push({ section, id: String(e.id), msg: `${field}="${v}" — нет такого id в ${targetName}`, severity }); }
  };
  ref('objects', 'modelId', models, 'models', 'error');
  ref('objects', 'materialId', materials, 'materials', 'error');
  for (const f of ['baseMap', 'bumpMap', 'maskMap', 'occlusionMap', 'emissionMap']) ref('materials', f, textures, 'textures', 'error');
  ref('items.base', 'modelId', models, 'models', 'warn');       // шмотка ссылается на незалитую 3D-модель — фолбэк на процедурку
  ref('monster-gear', 'modelId', models, 'models', 'warn');

  // 3) submeshMaterials{} на моделях → materials [error]
  for (const m of arr('models')) { const sm = m.submeshMaterials; if (sm && typeof sm === 'object') for (const [k, v] of Object.entries(sm as Record<string, unknown>)) if (typeof v === 'string' && v && !materials.has(v)) issues.push({ section: 'models', id: String(m.id), msg: `submeshMaterials["${k}"]="${v}" — нет в materials`, severity: 'error' }); }

  // ошибки — вперёд, потом предупреждения
  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Модалка-отчёт валидации: ошибки (красным) + предупреждения (жёлтым) по секциям, либо «чисто». `onForce` — публикация вопреки. */
function showValidationModal(issues: ConfigIssue[], onForce?: () => void): void {
  const errors = issues.filter((i) => i.severity === 'error'), warns = issues.filter((i) => i.severity === 'warn');
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:#16161f;border:1px solid #2c2c3a;border-radius:10px;max-width:680px;max-height:80vh;overflow:auto;padding:18px 20px;color:#e8e8f0;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.5)';
  const title = document.createElement('div');
  if (!issues.length) { title.textContent = '✓ Конфиг чист — битых ссылок не найдено'; title.style.cssText = 'font-size:15px;font-weight:600;color:#7fd67f'; }
  else { title.textContent = `${errors.length ? '⛔ Ошибок: ' + errors.length : '✓ Ошибок нет'}${warns.length ? ' · ⚠ предупреждений: ' + warns.length : ''}`; title.style.cssText = `font-size:15px;font-weight:600;color:${errors.length ? '#ff8080' : '#ffb020'};margin-bottom:8px`; }
  box.appendChild(title);
  const renderGroup = (list: ConfigIssue[], color: string): void => {
    const bySec: Record<string, ConfigIssue[]> = {};
    for (const i of list) (bySec[i.section] ??= []).push(i);
    for (const [sec, items] of Object.entries(bySec)) {
      const h = document.createElement('div'); h.textContent = `${sec} (${items.length})`; h.style.cssText = 'font-weight:600;color:#c8cbe0;margin:10px 0 4px'; box.appendChild(h);
      for (const i of items) { const row = document.createElement('div'); row.textContent = `• ${i.id}: ${i.msg}`; row.style.cssText = `color:${color};margin:2px 0 2px 10px`; box.appendChild(row); }
    }
  };
  if (errors.length) { const h = document.createElement('div'); h.textContent = '⛔ Ошибки (ломают рендер):'; h.style.cssText = 'color:#ff8080;font-weight:600;margin-top:10px'; box.appendChild(h); renderGroup(errors, '#e0a0a0'); }
  if (warns.length) { const h = document.createElement('div'); h.textContent = '⚠ Предупреждения (есть фолбэк):'; h.style.cssText = 'color:#ffb020;font-weight:600;margin-top:12px'; box.appendChild(h); renderGroup(warns, '#d0c090'); }
  const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end';
  if (onForce) btnRow.append(btn(errors.length ? 'Всё равно опубликовать' : 'Опубликовать', () => { overlay.remove(); onForce(); }, errors.length ? '#4a2a2a' : '#26406a'));
  btnRow.append(btn('Закрыть', () => overlay.remove()));
  box.appendChild(btnRow);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

/** Кнопка «🔎 Проверить конфиг»: прогнать валидатор и показать отчёт. */
async function runValidation(): Promise<void> {
  setStatus('Проверка ссылок и файлов ассетов…', '#9fb0c0');
  const issues = await validateConfig();
  const errs = issues.filter((i) => i.severity === 'error').length, warns = issues.length - errs;
  setStatus(issues.length ? `Ошибок: ${errs}, предупреждений: ${warns} (см. отчёт)` : 'Конфиг чист — битых ссылок нет.', errs ? '#ff8080' : issues.length ? '#ffb020' : '#7fd67f');
  showValidationModal(issues);
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

function btn(text: string, onClick: () => void, bg = '#2c2c3a', title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (title) b.title = title;   // «что именно делает кнопка» — подсказкой, а не догадкой по подписи
  b.style.cssText = `padding:7px 12px;cursor:pointer;background:${bg};color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:13px`;
  b.addEventListener('click', onClick);
  return b;
}
