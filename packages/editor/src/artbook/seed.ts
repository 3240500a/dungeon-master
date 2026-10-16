/**
 * ⭐ 16.10 (Артбук): СИД — базовые тексты вкладки (в репозитории, пишет агент). Три пространства:
 *  • `crypt`     — черновик «Артбук: нежить крипты» (`seed/crypt.json`, импорт `node tools/artbook-seed.mjs <draft.json>`);
 *  • `classes`   — классы героев (`seed/classes.json`, по `docs/GAME_BRIEF.txt` §4);
 *  • `locations` — заметки художнику по биомам (`seed/locations.json`).
 *
 * Грузится ДИНАМИЧЕСКИМ `import()` — свой чанк (черновик ~400 КБ), старт редактора его не ждёт. Правки владельца — поверх
 * по пути поля (`model.ts`); путь начинается с имени пространства: `crypt/subtypes/greece/lore`, `classes/classes/mage/lore`.
 *
 * Типы ниже — форма черновика, какой её собирает исследование (поля, которых у части записей нет, — необязательные).
 */

export interface Source { title: string; url: string }

export interface Era { id: string; name: string; ref: string; subtypes: string[]; note: string }

export interface LayerRow { floors: string; layer: string; subtype: string; inner: string; boss: string; portal: string }

export interface PaletteColor { role: string; hex: string }

export interface Subtype {
  id: string;
  /** Номер в порядке владельца (1 — Греция, … 5 — Египет и Междуречье). */
  ownerNo: number;
  name: string;
  altNames: string[];
  /** Скрытая справка: реальная привязка (игроку не печатается). */
  ref: string;
  era: string;
  eraIds?: string[];
  eraText: string;
  short: string;
  houses?: { id: string; name: string; ref: string; look: string; where: string }[];
  lore: string;
  decay: string;
  palette: PaletteColor[];
  glow: string;
  materials: string;
  silhouette: string[];
  motion: string;
  motifs: string[];
  gameplay: {
    traits: string[];
    signature: string;
    signatures: { name: string; text: string }[];
    weakness: string;
    counter: string[];
    resist: string;
    hole: string;
  };
  depth: string;
  firstWave: string[];
  reserve?: { name: string; ref: string; why: string }[];
  artNotes: string[];
  mergeNotes?: string[];
  notToDraw?: string[] | string;
  sources: Source[];
}

/** Архетип в конкретном подтипе (`archetypes[].perSubtype[<подтип>]`). */
export interface ArchetypeInSubtype {
  name: string;
  ref: string;
  gear: string;
  twist: string;
  telegraph?: string;
  elite?: string;
  silhouette?: string;
}

export interface Archetype {
  id: string;
  name: string;
  role: string;
  canon: string;
  canonRoles?: number[];
  question: string;
  kind: 'common' | 'unique';
  subtypes: string[];
  /** Привязка к монстру конфига, пока у монстров нет поля подтипа (решение владельца: нынешние зомби — Европа). */
  existingMonsterId?: string;
  existingAlso?: string[];
  behavior: string;
  mechanic: string;
  telegraph: string;
  elite: string;
  counter?: string;
  silhouette?: string;
  threat: string;
  queue?: string;
  engine: { have: string[]; need: string[] };
  perSubtype: Record<string, ArchetypeInSubtype>;
  waveBySubtype: Record<string, string>;
}

export interface CryptDraft {
  title: string;
  subtitle: string;
  status: string;
  schemaNote: string;
  intro: {
    purpose: string[];
    workflow: string[];
    naming: string[];
    ownerOrder: { owner: { n: number; id: string; text: string }[]; doc: string };
    lore: string[];
    marks: { mark: string; meaning: string }[];
    howTab: string[];
  };
  eras: Era[];
  eraNote: string;
  layers: { rows: LayerRow[]; variants: { id: string; name: string; text: string }[]; staging: string; alternative: string; engine: string; gearNote: string };
  decayLadder: {
    intro: string;
    rows: { subtype: string; body: string; weight: string; speed: string; takes: string; holds: string; gives: string }[];
    levers: string;
    readability: string;
    sources: Source[];
  };
  statuses: {
    intro: string;
    rows: { subtype: string; main: string; second: string; armor: string; weak: string; resist: string }[];
    note: string;
    sources: Source[];
  };
  signatures: {
    intro: string;
    rows: { subtype: string; habit: string; first: string; second: string; raise: string }[];
    bannerSplit: string;
  };
  subtypes: Subtype[];
  archetypes: Archetype[];
  matrix: {
    columns: { id: string; name: string; proto: string; ownerNo: number }[];
    common: { id: string; name: string; role: string; existingMonsterId?: string; cells: Record<string, string> }[];
    uniqueBySubtype: Record<string, { id: string; name: string; role: string }[]>;
    counts: Record<string, { common: number; unique: number; total: number }>;
    canonCoverage: { canon: number; role: string; cells: Record<string, string[]> }[];
    traits: { row: string; cells: Record<string, string> }[];
  };
  packs: {
    intro: string;
    budget: { role: string; threat: string }[];
    roomBudget: string;
    rules: string[];
    templates: { id: string; name: string; checks: string; perSubtype: Record<string, string> }[];
  };
  readability: {
    numbers: string[];
    hierarchy: string;
    rule: string;
    reads: string[];
    lost: string[];
    keys: { subtype: string; head: string; shield: string; metal: string; accent: string; glow: string }[];
    signals: { signal: string; meaning: string }[];
    threatColor: string;
    checks: string[];
    confusions: { a: string; b: string; fix: string }[];
  };
  engine: {
    codes: { code: string; name: string; cost: string; note: string }[];
    dataFixes: string[];
    beforeDemo: string[];
    existingMap: { id: string; name: string; to: string }[];
  };
  imageSlots: { subtype: string[]; archetype: string[] };
  questions: { n: number; q: string; options: string; rec: string }[];
  sources: Source[];
}

export interface ClassLore {
  id: string;
  title: string;
  role: string;
  attrs: string;
  culture: string;
  lore: string;
  gear: string;
  style: string;
  affinity: string;
  artNotes: string;
}
export interface ClassesSeed { intro: string[]; classes: ClassLore[] }

export interface LocationLore { id: string; look: string[]; artNotes: string }
export interface LocationsSeed { intro: string[]; biomes: LocationLore[] }

export interface ArtbookSeed {
  crypt: CryptDraft;
  classes: ClassesSeed;
  locations: LocationsSeed;
}

let cache: Promise<ArtbookSeed> | null = null;

/** Сид целиком (один раз за жизнь страницы). Не загрузился — промис отклоняется, вкладка показывает ошибку. */
export function loadSeed(): Promise<ArtbookSeed> {
  return (cache ??= Promise.all([
    import('./seed/crypt.json'),
    import('./seed/classes.json'),
    import('./seed/locations.json'),
  ]).then(([crypt, classes, locations]) => ({
    crypt: crypt.default as unknown as CryptDraft,
    classes: classes.default as unknown as ClassesSeed,
    locations: locations.default as unknown as LocationsSeed,
  })).catch((e: unknown) => { cache = null; throw e; }));
}
