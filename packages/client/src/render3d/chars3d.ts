// ── Реестр персонажей 3D (класс/фракция → пол/телосложение/оружие) — ИЗ СЕРВЕРНОГО КОНФИГА, без хардкода ростера ──
// Ростер (какие классы/фракции есть + их имена) берётся из /api/config (классы игры + монстры), закэшированного
// boot-обёрткой в localStorage['pe_config']. Создал класс/монстра в серверном редакторе → он появляется здесь.
// Внешность 3D (пол/телосложение/оружие) — ПРОИЗВОДНАЯ от конфига (оружие из startWeaponId, телосложение из стартовых
// атрибутов), поверх — сид-дефолты DEFAULT_APPEARANCE (сохраняют текущий вид) и авторские правки pe_appearance
// (серверный pose-ключ, редактируется в поз-редакторе). Никаких встроенных СПИСКОВ классов/монстров.
import type { BuildScale } from './humanoid.js';
import { ConfigRegistry } from '@dm/shared';

export interface Char { id: string; name: string; gender: 'male' | 'female'; build: BuildScale; weapon: string; builtin?: boolean }

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** id стартового оружия класса → ключ 3D-оружия (weapon3d). По ключевым словам — любой новый предмет ложится. */
export function deriveWeapon(weaponId: string | undefined): string {
  const s = (weaponId ?? '').toLowerCase();
  if (s.includes('crossbow') || s.includes('arbalest')) return 'crossbow';
  if (s.includes('bow')) return 'bow';
  if (s.includes('halberd') || s.includes('glaive') || s.includes('poleaxe')) return 'halberd';
  if (s.includes('spear') || s.includes('pike') || s.includes('lance') || s.includes('trident')) return 'spear';
  if (s.includes('axe')) return 'axe';
  if (s.includes('mace') || s.includes('hammer') || s.includes('maul') || s.includes('club') || s.includes('flail') || s.includes('morningstar') || s.includes('scepter')) return 'mace';
  if (s.includes('dagger') || s.includes('knife') || s.includes('dirk') || s.includes('kris')) return 'dagger';
  if (s.includes('wand') || s.includes('staff') || s.includes('stave') || s.includes('rod') || s.includes('orb')) return 'staff';
  return 'sword';
}

/** Телосложение из стартовых атрибутов (крепче str+vit → массивнее). Формула, не таблица — любой класс получит силуэт. */
function deriveBuild(attrs: Record<string, unknown> | undefined): BuildScale {
  const k = ((num(attrs?.['strength'], 12) + num(attrs?.['vitality'], 12)) / 2 - 12) * 0.03;
  return { arm: clamp(1 + k * 1.2, 0.8, 1.35), leg: clamp(1 + k, 0.85, 1.3), torso: clamp(1 + k * 1.4, 0.85, 1.4) };
}

// Сид-дефолты внешности для СУЩЕСТВУЮЩИХ id (сохраняют текущий вид). Это НЕ ростер — лишь косметика поверх дерайва,
// перебиваемая авторскими pe_appearance. Новый класс/фракция без записи здесь получает производную внешность.
type Look = Partial<Pick<Char, 'name' | 'gender' | 'build' | 'weapon'>>;
const DEFAULT_APPEARANCE: Record<string, Look> = {
  warrior: { gender: 'male', build: { arm: 1.1, leg: 1.1, torso: 1.15 }, weapon: 'axe' },
  mage: { gender: 'male', build: { arm: 0.9, leg: 0.9, torso: 0.9 }, weapon: 'staff' },
  archer: { gender: 'female', build: { arm: 0.85, leg: 0.9, torso: 0.85 }, weapon: 'bow' },
  zastupnik: { gender: 'male', build: { arm: 1.05, leg: 1.05, torso: 1.1 }, weapon: 'mace' },
  vyuga: { gender: 'female', build: { arm: 0.9, leg: 0.9, torso: 0.9 }, weapon: 'sword+shield' },
  arbalest: { gender: 'male', build: {}, weapon: 'crossbow' },
  vorozheya: { gender: 'female', build: { arm: 0.85, leg: 0.9, torso: 0.85 }, weapon: 'dagger' },
  undead: { name: 'Нежить', gender: 'male', build: { arm: 0.95, leg: 0.95, torso: 0.9 }, weapon: 'axe' },
  demon: { name: 'Демон', gender: 'male', build: { arm: 1.3, leg: 1.15, torso: 1.35 }, weapon: 'axe' },
  beast: { name: 'Зверь', gender: 'male', build: { arm: 1.15, leg: 1.25, torso: 1.2 }, weapon: 'axe' },
  monster: { name: 'Монстр (общий)', gender: 'male', build: { arm: 1.1, leg: 1.05, torso: 1.2 }, weapon: 'axe' },
};

/** Классы + монстры из СЕРВЕРНОГО конфига (кэш localStorage['pe_config']); офлайн-фолбэк — встроенные дефолты (те же данные). */
function configData(): { classes: Record<string, unknown>[]; monsters: Record<string, unknown>[] } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('pe_config') : null;
    if (raw) {
      const c = JSON.parse(raw) as { classes?: unknown; monsters?: unknown };
      if (Array.isArray(c.classes)) return { classes: c.classes as Record<string, unknown>[], monsters: (Array.isArray(c.monsters) ? c.monsters : []) as Record<string, unknown>[] };
    }
  } catch { /* нет кэша — фолбэк ниже */ }
  const reg = new ConfigRegistry(); reg.loadAll();
  return { classes: reg.get('classes') as unknown as Record<string, unknown>[], monsters: reg.get('monsters') as unknown as Record<string, unknown>[] };
}

type Appearance = Record<string, Look>;
function loadAppearance(): Appearance {
  try { return (JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('pe_appearance')) || '{}') as Appearance) || {}; } catch { return {}; }
}

/** Собрать Char: авторские правки (pe_appearance) → сид-дефолт → производная от конфига. */
function resolve(id: string, base: Look, ap: Appearance): Char {
  const a = ap[id] ?? {}, d = DEFAULT_APPEARANCE[id] ?? {};
  return {
    id,
    name: a.name ?? base.name ?? d.name ?? title(id),
    gender: a.gender ?? d.gender ?? base.gender ?? 'male',
    build: a.build ?? d.build ?? base.build ?? {},
    weapon: a.weapon ?? d.weapon ?? base.weapon ?? 'sword',
    builtin: true,
  };
}

// ── Живой ростер (пересобирается из конфига; массивы мутабельны, чтобы редактор/игра читали их как раньше) ──
export let CLASS_CHARS: Char[] = [];
export let MONSTER_CHARS: Char[] = [];
let MONSTER_IDS = new Set<string>();

/** Пересобрать ростер из серверного конфига + внешности. Зовётся на загрузке модуля и после правок внешности. */
export function buildRoster(): void {
  const { classes, monsters } = configData();
  const ap = loadAppearance();

  CLASS_CHARS = classes.map((c) => resolve(String(c['id']), {
    name: typeof c['name'] === 'string' ? c['name'] as string : undefined,
    build: deriveBuild(c['startAttributes'] as Record<string, unknown> | undefined),
    weapon: deriveWeapon(c['startWeaponId'] as string | undefined),
  }, ap)).filter((c) => c.id && c.id !== 'undefined');

  // Монстры как тюн-персонажи ПО ФРАКЦИЯМ: различимые силуэты. Всегда добавляем общий 'monster' (фолбэк monsterCharId).
  const byFaction = new Map<string, Record<string, unknown>[]>();
  for (const m of monsters) { const f = String(m['faction'] ?? 'monster'); if (!byFaction.has(f)) byFaction.set(f, []); byFaction.get(f)!.push(m); }
  if (!byFaction.has('monster')) byFaction.set('monster', []);
  MONSTER_CHARS = [...byFaction.entries()].map(([f, ms]) => {
    const ranged = ms.some((m) => String(m['ai'] ?? '').includes('ranged'));
    const avgHp = ms.length ? ms.reduce((s, m) => s + num(m['hp'], 20), 0) / ms.length : 20;
    const k = (avgHp - 20) * 0.006;   // толще при большем HP фракции
    return resolve(f, {
      build: { arm: clamp(1 + k, 0.85, 1.4), leg: clamp(1 + k * 0.9, 0.9, 1.35), torso: clamp(1 + k * 1.2, 0.85, 1.45) },
      weapon: ranged ? 'bow' : 'axe',
    }, ap);
  });
  MONSTER_IDS = new Set(MONSTER_CHARS.map((c) => c.id));
}

buildRoster();   // первичная сборка на загрузке модуля (boot уже закэшировал /api/config, если сервер доступен)

const SAFE: Char = { id: 'warrior', name: 'Воин', gender: 'male', build: {}, weapon: 'sword', builtin: true };

/** id фракции монстра → тюн-персонаж (известная фракция или общий 'monster'). */
export const monsterCharId = (faction: string): string => (MONSTER_IDS.has(faction) ? faction : 'monster');

/** Внешность 3D по id класса/фракции (фолбэк — первый класс либо безопасная заглушка). */
export const charFor = (id: string): Char => [...CLASS_CHARS, ...MONSTER_CHARS].find((c) => c.id === id) ?? CLASS_CHARS[0] ?? SAFE;
