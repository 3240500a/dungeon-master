/**
 * ⭐ 16.10 (Артбук): СИД — базовые тексты вкладки (в репозитории, пишет агент). Три пространства:
 *  • `crypt`     — черновик «Артбук: нежить крипты» (`seed/crypt.json`, импорт `node tools/artbook-seed.mjs <draft.json>`);
 *  • `classes`   — классы героев (`seed/classes.json`, по `docs/GAME_BRIEF.txt` §4);
 *  • `locations` — заметки художнику по биомам (`seed/locations.json`).
 *
 * Грузится ДИНАМИЧЕСКИМ `import()` — свой чанк (черновик ~550 КБ), старт редактора его не ждёт. Правки владельца — поверх
 * по пути поля (`model.ts`); путь начинается с имени пространства: `crypt/subtypes/greece/lore`, `classes/classes/mage/lore`.
 *
 * ⭐ 17.10 РОСТЕРЫ ПО ЯРУСАМ (v2, решения владельца 17.10): по файлу на подтип — `seed/v2/<подтип>.json` (карточки трёх
 * ярусов 3 ближника + 2 стрелка, три босса 5 / 14 / 19, особые, пачки, комплект моделей, новые вещи гира, «куда ушли прежние
 * карточки», банк идей) и короткий `seed/v2/index.json` (подтипы и счёты, общие на крипту таблицы перехода ярусов и
 * стойкости, тексты «Части 2», очереди ростера). Импорт — `node tools/artbook-seed.mjs --v2 <папка>`. Ростеры НЕ лежат в
 * crypt.json: ~140 КБ на подтип, а сид клонируется на каждую отрисовку — грузятся лениво (`loadRoster`, `loadRosterIndex`),
 * каждый своим чанком.
 *
 * Типы ниже — форма черновика, какой её собирает исследование (поля, которых у части записей нет, — необязательные).
 */

export interface Source { title: string; url: string }

export interface Era { id: string; name: string; ref: string; subtypes: string[]; note: string }

export interface PaletteColor { role: string; hex: string }

export interface Subtype {
  id: string;
  /** Номер в порядке владельца (1 — Греция, 2 — Рим, 3 — викинги, 4 — Европа, 5 — Двор Тростника, 6 — Дом Праха). */
  ownerNo: number;
  name: string;
  altNames: string[];
  /** Скрытая справка: реальная привязка (игроку не печатается). */
  ref: string;
  era: string;
  eraIds?: string[];
  eraText: string;
  short: string;
  /** Два «дома» слитого подтипа Египет-Междуречье — до разделения 16.10; у нынешних подтипов нет. */
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
    signatures: { name: string; text: string; engine?: string }[];
    weakness: string;
    counter: string[];
    resist: string;
    hole: string;
  };
  /** «Где встречается»: по правилу выбора подтипа при спуске, без номеров этажей (решение 16.10). */
  depth: string;
  firstWave: string[];
  reserve?: { name: string; ref: string; why: string }[];
  artNotes: string[];
  /** Что слито из других подтипов (до 16.10; у нынешних подтипов нет). */
  mergeNotes?: string[];
  /** ⭐ 16.10: что разделено — у Двора Тростника и Дома Праха, отделённых от слитого подтипа. */
  splitNotes?: string[];
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
  /** Прежний id (уникальный слитого подтипа стал вариантом общего архетипа: `em_lyrist` → `herald.mesopotamia`). */
  oldId?: string;
}

/** Архетип прежней раскладки по ролям — АРХИВ до 17.10 (карточки теперь — бойцы ярусов ростеров v2). */
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
  /** Прежний id (`em_*` слитого подтипа → `eg_*` / `mes_*`). */
  oldId?: string;
  /** Откуда взят (вариант элиты или резерва прежнего архетипа). */
  fromOld?: string;
  behavior: string;
  mechanic: string;
  telegraph: string;
  elite: string;
  counter?: string;
  silhouette?: string;
  threat: string;
  /** Очередь прежней раскладки (1 — первая волна, 2 — вторая); у общих — `null`. */
  queue?: number | null;
  engine: { have: string[]; need: string[] };
  perSubtype: Record<string, ArchetypeInSubtype>;
  waveBySubtype: Record<string, string>;
}

/** Вопрос владельцу: варианты и рекомендация исследования, решение владельца (16.10) и что поменялось в документе. */
export interface Question {
  n: number;
  q: string;
  options?: string;
  rec?: string;
  /** Подпись рекомендации, если она не просто «Рекомендация» («Рекомендация по производству»). */
  recTitle?: string;
  /** Что поменялось в документе после решения. */
  changed?: string;
  /** ⭐ 16.10: «Решение владельца» из документа (дополнения 17.10 — в том же тексте). */
  decision: string;
}

/** ⭐ 17.10: пункт сводки решений владельца (16–17.10). `title` — жирное начало пункта, `text` — пункт целиком. */
export interface Decision { id: string; title: string; text: string }

/** ⭐ 16.10: выбор подтипа при спуске — вместо прежних «слоёв по этажам круга». */
export interface Selection {
  intro: string;
  /** Правила: выбор, срок, печать, боссы, подмес, сколько готово. */
  rules: { id: string; rule: string; how: string }[];
  /** Порядок производства подтипов (Европа первой — 17.10). */
  productionOrder: string;
  /** Что нужно в коде (на будущее). */
  engine: string;
  /** Печать подтипа на алтаре метки. */
  seal: { title: string; intro: string; items: { id: string; name: string; text: string }[]; note: string };
  /** Ступени гира — по уровню монстра, ярус — по месту этажа в круге. */
  gearNote: string;
  /** Слои Некрополя — лор, а не раскладка. */
  loreNote: string;
}

export interface CryptDraft {
  title: string;
  subtitle: string;
  status: string;
  schemaNote: string;
  /** ⭐ 17.10: сводка решений владельца (16–17.10) — заголовок, вступление, пункты. */
  decisionsTitle: string;
  decisionsIntro: string;
  decisions: Decision[];
  intro: {
    purpose: string[];
    workflow: string[];
    naming: string[];
    ownerOrder: { owner: { n: number; id: string; text: string }[]; doc: string };
    /** «Это лор, а не раскладка игры» (решение 16.10) — пометка над лором слоёв. */
    loreNote: string;
    lore: string[];
    marks: { mark: string; meaning: string }[];
    howTab: string[];
  };
  eras: Era[];
  eraNote: string;
  selection: Selection;
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
    /** ⭐ 16.10: «Настройка» и «Не единственный, а самый частый» (родной ×1.25 / второй ×1.0 / чужой ×0.8). */
    notes: { id: string; title: string; text: string; items: string[]; after: string }[];
    sources: Source[];
  };
  signatures: {
    intro: string;
    rows: { subtype: string; habit: string; first: string; second: string; raise: string }[];
    bannerSplit: string;
  };
  subtypes: Subtype[];
  /** Прежняя раскладка по ролям (archetypes, matrix) — архив до 17.10. */
  archiveNote: string;
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
    /** Составы босс-залов (пока только у Дома Праха и Двора Тростника). */
    bossHall?: { note: string; perSubtype: Record<string, string> };
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
    /** ⭐ 16.10: код сейчас не пишем — пометки «есть» / «легко» / «на будущее». */
    marksIntro: string;
    marks: { id: string; mark: string; meaning: string }[];
    codes: { code: string; name: string; cost: string; note: string }[];
    dataFixes: string[];
    /** Заголовок списка — «Если дойдём до кода — что брать первым (на будущее)» (был «До демо»). */
    beforeDemoTitle: string;
    beforeDemo: string[];
    existingMap: { id: string; name: string; to: string }[];
    /** Нынешние 19 зомби — тестовые (решение 17.10). */
    existingMapNote: string;
    /** ⭐ 16.10: составные юниты (К15) — как выглядят и как сделать. */
    composite: {
      title: string;
      intro: string;
      units: { id: string; name: string; text: string }[];
      stepsIntro: string;
      steps: { id: string; name: string; text: string }[];
      fallback: string;
      artist: string;
    };
  };
  imageSlots: { subtype: string[]; archetype: string[] };
  questions: Question[];
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
  /**
   * ⭐ 17.10: ЗАГРУЖЕННЫЕ ростеры v2 (`<подтип>` → `RosterV2`, `index` → `RosterIndex`) — только в `ctx.seed` страницы, чтобы
   * пути правки `v2/<подтип>/…` находили текст сида. В сид, который клонируется на каждую отрисовку (`applyTexts`), не кладутся.
   */
  v2?: Record<string, unknown>;
}

// ── Ростеры по ярусам (v2, 17.10) ────────────────────────────────────────────────────────────────

/** Ярус снаряжения = тир силы: лёгкий — weak, средний — medium, тяжёлый — strong (боссы — boss). */
export type TierId = 'light' | 'medium' | 'heavy';
export type PowerTier = 'weak' | 'medium' | 'strong' | 'boss';
export type CombatKind = 'melee' | 'ranged' | 'support';
/** Множители стойкости к урону по монстру: режущий, колющий, дробящий, молния. */
export type DamageMults = Partial<Record<'slashing' | 'piercing' | 'crushing' | 'lightning', number>>;

export interface RosterWeapon {
  /** Оружие как в тексте карточки (с id гира). */
  text: string;
  hands: number;
  /** Статус удара (daze / wound / bleed / sunder …) и его имя. */
  status: string;
  statusName: string;
  /** Сила статуса у подтипа: родной ×1.25, второй ×1.0, чужой ×0.8. */
  mult: number;
  /** id вещи гира (`u-…`); `fallback` — чем заменить, пока новой вещи нет. */
  gear: string;
  fallback: string | null;
  fallbackStatus?: string | null;
  view?: string | null;
}

/** Боец яруса: 3 ближника + 2 стрелка на ярус. Пометки механик в тексте — `[есть]`, `[легко: …]`, `[на будущее: К…]`. */
export interface RosterCard {
  id: string;
  name: string;
  combat: CombatKind;
  role: string;
  engineRole: string;
  armor: string;
  /** Класс брони игры: quilted, leather, chain, segmented, plate. */
  armorClass: string;
  helm: string;
  shield: string;
  weapon: RosterWeapon;
  move: string;
  silhouette: string;
  /** Скрытая справка (реальный прототип). */
  prototype: string;
  weight: number;
  speed: number;
  /** ⭐ 22.10: описание для промта Nano Banana (середина промта; стиль и фон — общие, `promptOf`). */
  prompt?: string;
  /** ⭐ 23.10: своё начало промта вместо общего стиля (`v2/index/prompt/style`) — когда «один персонаж в полный рост» не подходит (колесница с упряжкой). */
  promptStyle?: string;
}

export interface RosterTier {
  id: TierId;
  name: string;
  powerTier: PowerTier;
  /** Пласт эпохи яруса (у Междуречья ещё `eraText`). */
  era: string;
  eraText?: string;
  burialGrade?: string;
  force?: string;
  decay?: string;
  lead?: string;
  armor: string;
  helms: string;
  shields: string;
  limbs: string;
  resist: string;
  melee: string;
  ranged: string;
  weightSpeed: string;
  statuses: string;
  silhouette: string;
  cards: RosterCard[];
}

/** Босс подтипа: лёгкий — 5-й этаж круга, средний — 14-й, актовый — 19-й. */
export interface RosterBoss {
  id: string;
  name: string;
  floor: number;
  tier: TierId;
  powerTier: PowerTier;
  armorClass: string;
  look: string[];
  hall: string;
  differs: string;
  fight: string[];
  /** Базовая версия без кода. */
  mvp: string;
  prototype: string;
  title?: string;
  style?: string;
  /** ⭐ 22.10: описание для промта Nano Banana (середина промта; стиль и фон — общие, `promptOf`). */
  prompt?: string;
  /** ⭐ 23.10: своё начало промта вместо общего стиля (`v2/index/prompt/style`) — когда «один персонаж в полный рост» не подходит (колесница с упряжкой). */
  promptStyle?: string;
}

/** Особый подтипа (4–6, первая волна — 2–4): не больше одного на пачку, тир — своего яруса. */
export interface RosterSpecial {
  id: string;
  name: string;
  tier: TierId;
  powerTier: PowerTier;
  weight: number;
  speed: number;
  wave: number;
  armorClass: string;
  /** Статус удара (у поддержки без удара — `null`). */
  status: string | null;
  combat: CombatKind;
  look: string;
  mechanic: string;
  telegraph: string;
  counter: string;
  prototype: string;
  engineRole?: string;
  tierNote?: string;
  /** ⭐ 22.10: описание для промта Nano Banana (середина промта; стиль и фон — общие, `promptOf`). */
  prompt?: string;
  /** ⭐ 23.10: своё начало промта вместо общего стиля (`v2/index/prompt/style`) — когда «один персонаж в полный рост» не подходит (колесница с упряжкой). */
  promptStyle?: string;
}

/** Строка состава пачки: `id` — id карточки (`card` — её имя). */
export interface RosterPackMember { id: string; card: string; count: number }

export interface RosterPack {
  id: string;
  name: string;
  floors: string;
  tiers: string;
  members: RosterPackMember[];
  optional: RosterPackMember[];
  optionalText?: string;
  melee: number;
  ranged: number;
  support: number;
  /** Статус → число бойцов пачки, которые его вешают. */
  statusCount: Record<string, number>;
  extra: string[];
  checks: string;
}

/** Строка «Комплекта моделей по ярусам» (`id`: common / light / medium / heavy / bossesSpecials). */
export interface RosterKitRow { id: string; tier: string; torso: string; helm: string; limbs: string; shields: string; weapons: string; extra: string }

export interface RosterGear { id: string; name: string; spec: string; for: string }

/** «Куда ушли прежние карточки»: `id` — id архетипа архива (crypt.json), у кого его нет — транслит имени. */
export interface RosterMigration { id: string; was: string; archetype: string; became: string; note: string }

/** Полоса перехода ярусов по кругу: доли лёгкого / среднего / тяжёлого яруса в пачках, % (`id` = `band`). */
export interface RosterBand {
  id: string;
  band: string;
  floors: string;
  light: number;
  medium: number;
  heavy: number;
  /** Сейчас в игре (доли тиров по нынешнему конфигу). */
  now: string;
  bosses: string;
  specials: string;
  player: string;
}

export interface RosterBankBoss {
  id: string;
  key: string;
  name: string;
  origin: string;
  look: string[];
  differs: string;
  fight: string[];
  mvp: string;
  pro: string;
  con: string;
  prototype: string;
}

export interface RosterIdea { id: string; name: string; origin: string; what: string; why: string; needs: string }

export interface RosterStatusRule { status: string; mult: number }

export interface RosterRules {
  tiers: string;
  perTier: string;
  eras: Record<TierId, string>;
  circle: string;
  cuirass: string;
  brigandine: string;
  limbs: string;
  subtypeRoll: string;
  friendlyFire: string;
  /** Статусы подтипа: родной ×1.25, второй ×1.0, чужие ×0.8 (решение 16.10, стартовые значения). */
  statuses: { native: RosterStatusRule; second: RosterStatusRule; foreign: { mult: number; list: string[] } };
  /** Стойкость по ярусу (одна на все подтипы) и лестница разложения подтипа поверх неё. */
  tierResist: {
    light: DamageMults;
    medium: DamageMults;
    heavy: DamageMults;
    note: string;
    decay: Record<string, number | Record<string, number | string>>;
    slashingTotal?: Partial<Record<TierId, number>>;
    heavyStacked?: Record<string, number | string>;
  };
  /** Этаж → id босса. */
  bosses: Record<string, string>;
  marks: string[];
  /** Подписи подтипа: строкой или записью (`id` — транслит имени). */
  signatures?: (string | { id: string; name: string; text: string; engine?: string })[];
  palette?: Record<string, string>;
  ladder?: string;
  armorAnswer?: string;
  colorRule?: string;
  burialGrade?: Partial<Record<TierId, string>>;
  decayByTier?: Partial<Record<TierId, string>>;
  decayStages?: Partial<Record<TierId, string>>;
  scale?: string;
  subtypeResist?: string;
  resistCombine?: string;
  cult?: string;
  cults?: string;
  names?: string;
  decay?: string;
  hole?: string;
}

/** Ростер подтипа по ярусам (`seed/v2/<подтип>.json`). */
export interface RosterV2 {
  id: string;
  subtypeName: string;
  version: string;
  date: string;
  title: string;
  altNames?: string[];
  intro: string[];
  rules: RosterRules;
  gridNotes: string[];
  tiers: RosterTier[];
  liberties: string[];
  transition: { bands: RosterBand[]; notes: string[] };
  /** Счёт статусов: по карточкам (родной — самый частый), без новых вещей гира, по особым и пачкам. */
  statusCount: {
    cards: Record<string, number>;
    cardsWithoutNewGear: Record<string, number>;
    specials: Record<string, number>;
    packs: Record<string, number>;
    packsMeleeRanged: { melee: number; ranged: number; support: number };
    specialsWithoutHit?: string[];
  };
  bosses: RosterBoss[];
  bossesNote: string;
  specials: RosterSpecial[];
  specialsNote: string[];
  packs: RosterPack[];
  packRule: string;
  kit: RosterKitRow[];
  kitNotes: string[];
  newGear: RosterGear[];
  migrationIntro: string;
  migration: RosterMigration[];
  migrationNote?: string;
  openQuestionsNote: string;
  openQuestions: string[];
  decidedNote: string;
  decided: string[];
  ideaBank: { note: string; bosses: RosterBankBoss[]; ideas: RosterIdea[] };
  /** ⭐ 22.10: фон подтипа для промтов Nano Banana (цвет фона и туман — у каждого подтипа свой). */
  promptBackdrop?: string;
  /** ⭐ 25.10: промты заглавной картинки подтипа (отряд из 15 на лестнице склепа): целиком, окружение, у Европы — три группы. */
  keyArt?: { prompts: RosterKeyArtPrompt[] };
}

/** Промт заглавной картинки — цельный, копируется как есть (не собирается из стиля и фона, как у карточек). */
export interface RosterKeyArtPrompt {
  id: string;
  title: string;
  text: string;
  /** Как пользоваться: что приложить к промту, откуда он взялся. */
  note?: string;
}

/** Очередь ростера: «1 · сначала» (лёгкий и средний ярус), «2 · следом» (тяжёлый + босс 5), «3 · потом» (боссы 14, 19 и особые), «Р» (банк идей). */
export interface RosterQueue {
  id: string;
  label: string;
  text: string;
  tiers?: TierId[];
  bossFloors?: number[];
  specials?: boolean;
  bank?: boolean;
}

export interface RosterSummary {
  id: string;
  name: string;
  ownerNo: number;
  file: string;
  title: string;
  native: RosterStatusRule;
  second: RosterStatusRule;
  counts: {
    cards: number; melee: number; ranged: number; bosses: number; specials: number; specialsWave1: number; packs: number;
    newGear: number; kit: number; bankBosses: number; bankIdeas: number; openQuestions: number;
  };
}

/** `seed/v2/index.json`: сводка ростеров, общие на крипту таблицы и тексты «Части 2 · Ярусы и архетипы». */
export interface RosterIndex {
  version: string;
  date: string;
  note: string;
  /** Подтипы в порядке crypt.json (снизу вверх по слоям Некрополя). */
  order: string[];
  subtypes: RosterSummary[];
  statusMults: { native: number; second: number; foreign: number };
  tierResistMult: Record<TierId, DamageMults>;
  title: string;
  intro: string;
  archiveNote: string;
  howTo: { id: string; title: string; text: string }[];
  transition: { intro: string; bands: { id: string; floors: string; light: number; medium: number; heavy: number; bosses: string }[]; notes: string[] };
  tierResist: { intro: string; rows: ({ id: TierId; name: string; meaning: string } & DamageMults)[]; note: string };
  matrix: { intro: string; armorNote: string };
  bosses: { intro: string; types: { id: string; type: string; where: string }[]; note: string; short: Record<string, { combat: string; short: string }> };
  specials: { flavor: Record<string, string>; note: string; short: Record<string, string> };
  statuses: { rows: { subtype: string; armor: string; ladder: string }[]; note: string };
  countsNote: string;
  openAfterCheck: { intro: string; items: { id: string; title: string; text: string }[] };
  whereIs: string[];
  roster: { intro: string; queues: RosterQueue[]; orderNote: string; mechNote: string; productionOrder: string[]; countsNote: string };
  /** ⭐ 22.10: общие части промта Nano Banana — стиль (начало первого абзаца) и концовка; `note` — как промт собирается. */
  /** `keyArt` — ⭐ 25.10 общая заметка к промтам заглавной картинки подтипа. */
  prompt?: { style: string; close: string; note?: string; keyArt?: string };
}

/** Строка очереди ростера: карточка яруса, босс, особый или запись банка идей. */
export interface QueueRow { queue: string; kind: 'card' | 'boss' | 'special' | 'bank'; id: string; name: string; tier?: TierId }

/**
 * Очередь работ по подтипу (вкладка «Ростер и очерёдность»): правила — из `index.roster.queues`, порядок внутри очереди —
 * ярусы по порядку, боссы по этажу, особые первой волны раньше второй, банк — варианты боссов, затем идеи.
 */
export function rosterQueue(r: RosterV2, queues: readonly RosterQueue[]): QueueRow[] {
  const out: QueueRow[] = [];
  for (const q of queues) {
    for (const t of r.tiers) if (q.tiers?.includes(t.id)) for (const c of t.cards) out.push({ queue: q.id, kind: 'card', id: c.id, name: c.name, tier: t.id });
    for (const fl of q.bossFloors ?? []) for (const b of r.bosses) if (b.floor === fl) out.push({ queue: q.id, kind: 'boss', id: b.id, name: b.name, tier: b.tier });
    if (q.specials) for (const s of [...r.specials].sort((a, b) => a.wave - b.wave)) out.push({ queue: q.id, kind: 'special', id: s.id, name: s.name, tier: s.tier });
    if (q.bank) for (const x of [...r.ideaBank.bosses, ...r.ideaBank.ideas]) out.push({ queue: q.id, kind: 'bank', id: x.id, name: x.name });
  }
  return out;
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

/** Файлы `seed/v2/*.json` — каждый своим чанком, грузятся по требованию. */
const V2_FILES = import.meta.glob('./seed/v2/*.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;
const v2Cache = new Map<string, Promise<unknown>>();

function loadV2(file: string): Promise<unknown> {
  const hit = v2Cache.get(file);
  if (hit) return hit;
  const load = V2_FILES[`./seed/v2/${file}`];
  if (!load) return Promise.reject(new Error(`нет файла сида v2: ${file}`));
  const p = load().catch((e: unknown) => { v2Cache.delete(file); throw e; });
  v2Cache.set(file, p);
  return p;
}

/** Ростер подтипа по ярусам (`seed/v2/<подтип>.json`), один раз за жизнь страницы. Нет ростера — промис отклоняется. */
export const loadRoster = (subId: string): Promise<RosterV2> => loadV2(`${subId}.json`) as Promise<RosterV2>;

/** Сводка ростеров и общие таблицы (`seed/v2/index.json`). */
export const loadRosterIndex = (): Promise<RosterIndex> => loadV2('index.json') as Promise<RosterIndex>;

/** Есть ли ростер у подтипа (без загрузки). */
export const hasRoster = (subId: string): boolean => `./seed/v2/${subId}.json` in V2_FILES;
