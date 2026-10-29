/**
 * ⭐ ДРЕВО СКИЛОВ ГЕРОЯ — вид для клиента (C# `DmSkillTree.Build`, веб `skills/skillTreeView.ts` renderSkillTree без DOM): видимые ветки
 * (универсальные + своя классовая), узлы (квадраты; узел-вставка — ромб цвета своего типа), рёбра (золото — оба вложены), подписи веток у
 * внешнего края, шапка. Ключи = поля C# `DmSkillTree.Model` / `NodeV` / `EdgeV` / `LabelV`.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { dmgColor, dmgName, elementOf } from './heroText.js';

type SkillNode = ConfigShapes['skill-tree']['nodes'][number];
type SkillBranch = ConfigShapes['skill-tree']['branches'][number];

/** = C# `DmSkillTree.NodeV`. `x`/`y` — центр узла в координатах древа; `rx` — скругление квадрата (у ромба поля нет). */
export interface SkillTreeNodeV {
  id: string; x: number; y: number; size: number; sw: number; rx?: number;
  shape: 'rect' | 'diamond'; fill: string; stroke: string; tip: string;
  alloc: boolean; avail: boolean; notable: boolean;
}
/** = C# `DmSkillTree.EdgeV`: `op` — непрозрачность линии. */
export interface SkillTreeEdgeV { a: string; b: string; x1: number; y1: number; x2: number; y2: number; sw: number; op: number; stroke: string }
/** = C# `DmSkillTree.LabelV`: подпись ветки (`anchor` — start / middle / end). */
export interface SkillTreeLabelV { x: number; y: number; anchor: 'start' | 'middle' | 'end'; fill: string; text: string }
/** = C# `DmSkillTree.Model`. */
export interface SkillTreeModel { nodes: SkillTreeNodeV[]; edges: SkillTreeEdgeV[]; labels: SkillTreeLabelV[]; header: string }

/** Цвет стороны древа по ресурсу и группе ветки: классовые — золото, магия — синий, боевые — жёлто-зелёный, броня — тан. */
function sideColor(resource: string, group: string): string {
  if (group === 'class') return '#d0a94e';
  if (resource === 'mana') return '#5478b0';
  if (resource === 'stamina') return '#8a9a3e';
  return '#8a7d64';
}
const elementColor = (cfg: ConfigRegistry, el: string): string => (el === 'mastery' ? '#6a6a7a' : dmgColor(cfg, el));
const elementLabel = (cfg: ConfigRegistry, el: string): string => (el === 'mastery' ? 'Мастерство' : dmgName(cfg, el));
/** Золотой контур входа ветки (`COLORS.gold`). */
const ENTRY_GOLD = '#dca94b';

/** ⭐ Замена `DmSkillTree.Build`: модель окна древа скилов героя. */
export function skillTreeView(cfg: ConfigRegistry, save: SaveState): SkillTreeModel {
  const tree = cfg.get('skill-tree');
  const own = save.classId;
  const vis = new Map<string, SkillBranch>(tree.branches.filter((b) => !b.classId || b.classId === own).map((b) => [b.id, b] as const));
  const nodes = (tree.nodes as SkillNode[]).filter((n) => vis.has(n.branchId));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges = tree.edges.filter(([a, b]) => byId.has(a) && byId.has(b));
  const rankOf = (id: string): number => save.skills[id] ?? 0;
  const neighbors = (id: string): string[] => edges.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
  const entries = new Set(tree.entryNodes);
  const isAvail = (n: SkillNode): boolean => entries.has(n.id) || neighbors(n.id).some((x) => rankOf(x) > 0);
  const inserts = cfg.get('skill-inserts');
  const insertTypes = cfg.get('skill-insert-types');

  const model: SkillTreeModel = {
    nodes: [], edges: [], labels: [],
    header: `Очки скиллов: ${save.unspentSkillPoints} · колесо — зум, перетаскивание — панорама, клик по доступному узлу — вложить очко · ромб — вставка для сборки скилов`,
  };

  for (const [a, b] of edges) {
    const na = byId.get(a)!, nb = byId.get(b)!;
    const both = rankOf(a) > 0 && rankOf(b) > 0;
    const br = vis.get(na.branchId)!;
    model.edges.push({ a, b, x1: na.x, y1: na.y, x2: nb.x, y2: nb.y, stroke: both ? '#d9b45a' : sideColor(br.resource, br.group), sw: both ? 3 : 1.4, op: both ? 1 : 0.45 });
  }

  for (const n of nodes) {
    const rank = rankOf(n.id);
    const alloc = rank > 0;
    const avail = !alloc && isAvail(n);
    const isActive = !!n.effect.active;
    const notable = !!n.notable;
    const br = vis.get(n.branchId)!;
    const insId = n.effect.grantsInsert;
    const ins = insId ? inserts.find((x) => x.id === insId) : undefined;
    const insColor = ins ? insertTypes.find((t) => t.id === ins.type)?.color : undefined;
    const el = elementOf(n);
    const accent = insColor ?? (isActive ? elementColor(cfg, el) : sideColor(br.resource, br.group));
    const size = notable ? 16 : isActive || ins ? 13 : 10;
    let fill = '#141821', stroke = '#333a48', sw = notable ? 2.4 : 1.6;
    if (alloc) { fill = accent; stroke = '#f2d792'; sw = notable ? 3 : 2.2; }
    else if (avail) {
      const low = save.level < n.levelReq;
      fill = low ? '#241d17' : '#1c2430';
      stroke = low ? '#6b563a' : accent;
      sw = notable ? 3 : 2;
    }
    if (entries.has(n.id) && !alloc) stroke = ENTRY_GOLD;
    const kind = isActive ? 'Активный скилл' : ins ? 'Вставка для сборки скилов' : 'Пассивный скилл';
    const tip: (string | undefined)[] = [n.name, `${kind} · ${br.name}`, n.description];
    if (isActive) tip.push(`Стихия: ${elementLabel(cfg, el)}`);
    tip.push(`ранг ${rank}/${n.maxRank} · ${rank >= n.maxRank ? 'макс. ранг' : `след. ранг: ${n.cost.amount} очк.`}`);
    if (save.level < n.levelReq) tip.push(`требуется уровень ${n.levelReq}`);
    if (ins) tip.push(`◆ Открывает вставку: ${ins.name}`, ins.description);
    model.nodes.push({
      id: n.id, x: n.x, y: n.y, size, sw, ...(ins ? {} : { rx: notable ? 5 : 3 }),
      shape: ins ? 'diamond' : 'rect', fill, stroke, alloc, avail, notable,
      tip: tip.map((t) => (t ?? '').trim()).filter((t) => t.length > 0).join('\n'),
    });
  }

  for (const br of vis.values()) {
    const bn = nodes.filter((n) => n.branchId === br.id);
    if (!bn.length) continue;
    let far = bn[0]!, fd = far.x * far.x + far.y * far.y;
    for (const n of bn) { const d = n.x * n.x + n.y * n.y; if (d > fd) { fd = d; far = n; } }
    const len = Math.max(1, Math.hypot(far.x, far.y));
    const lx = far.x + (far.x / len) * 44, ly = far.y + (far.y / len) * 44;
    model.labels.push({ x: lx, y: ly, anchor: lx < -20 ? 'end' : lx > 20 ? 'start' : 'middle', fill: sideColor(br.resource, br.group), text: br.name });
  }
  return model;
}
