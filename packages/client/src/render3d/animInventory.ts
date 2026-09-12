/**
 * ИНВЕНТАРЬ АНИМАЦИЙ (Ф7): что есть, сколько, чего не хватает и что сломано.
 *
 * Зачем отдельная страница. Библиотека выросла до сотен клипов, и на три вопроса ответа не было
 * нигде: «полный ли набор у персонажа», «нет ли дублей» и «не ссылается ли что-нибудь в никуда».
 * Каждый из них выяснялся в бою, а дубли ещё и коварны: `find()` берёт ПЕРВОЕ совпадение, поэтому
 * семь копий из восьми мертвы, и править можно совсем не ту запись, которую читает игра.
 *
 * Модуль ЧИСТЫЙ и принимает уже разобранные данные. Это не педантизм: инвентарь нужен В ДВУХ местах —
 * в поз-редакторе (он видит ЛОКАЛЬНУЮ рабочую копию) и в конфиг-редакторе (он видит только
 * опубликованное на сервере). Считать одно и то же двумя кусками кода значит получить две правды и
 * спорить, которая врёт; поэтому считает один, а рисуют двое.
 */

/** Минимум, который инвентарю нужен от клипа. */
export interface InvClip { name: string; character: string; weapon: string; keys: unknown[] }

/** Контракт набора: что персонаж обязан иметь. Список из плана Ф1 — он же документация схемы имён. */
export const REQUIRED: { group: string; names: readonly string[] }[] = [
  { group: 'базовые стойки', names: ['idle_relax', 'idle_incombat'] },
  { group: 'ходьба', names: ['walk_fwd', 'walk_back', 'walk_strafe_L', 'walk_strafe_R'] },
  { group: 'бег', names: ['run_fwd', 'run_back', 'run_strafe_L', 'run_strafe_R'] },
  { group: 'повороты на месте', names: ['turn_L_45', 'turn_R_45', 'turn_L_90', 'turn_R_90', 'turn_L_180', 'turn_R_180'] },
  { group: 'разворот на бегу', names: ['pivot_run_180'] },
  { group: 'удары без оружия', names: ['hit_unarmed_l_01', 'hit_unarmed_r_01'] },
  { group: 'реакции и падение', names: ['stagger', 'knockdown_fall', 'ground_idle', 'getup', 'death'] },
  { group: 'реакция на попадание', names: ['hit_react_F', 'hit_react_B', 'hit_react_L', 'hit_react_R'] },
  { group: 'уклонение', names: ['dodge_F', 'dodge_B', 'dodge_L', 'dodge_R'] },
  { group: 'каст', names: ['cast_windup', 'cast_loop', 'cast_release'] },
];

export interface InvGroup { group: string; have: string[]; missing: string[] }
export interface InvDup { key: string; count: number }
export interface InvBroken { where: string; ref: string }

export interface InvChar {
  character: string;
  /** Всего клипов персонажа (включая оружейные, которых в контракте нет). */
  total: number;
  /** Сколько из контракта закрыто и сколько всего требуется. */
  done: number;
  need: number;
  groups: InvGroup[];
  /** Одинаковые `имя+оружие` внутри персонажа. Самая вредная находка: живёт только первая запись. */
  dups: InvDup[];
  /** Пустые клипы: запись есть, кадров нет — выглядят как готовые, а не играют. */
  empty: string[];
  /** Ссылки в никуда из конфигов (`pe_anim`, `pe_loco`, `pe_attacks`). */
  broken: InvBroken[];
}

export interface InvInput {
  clips: readonly InvClip[];
  /** Привязки состояний/локомоции: персонаж → имя состояния → имя клипа. */
  anim?: Record<string, { states?: Record<string, unknown> } | undefined>;
  /** Прочие ссылки на клипы по имени: откуда и куда. Проверяются на существование. */
  refs?: readonly { where: string; character: string; ref: string }[];
}

/** Имя клипа из записи состояния: строка — это имя, объект — поле `clip`, иначе имя самого состояния. */
export function stateClipName(state: string, raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { clip?: unknown }).clip === 'string') return (raw as { clip: string }).clip;
  return state;
}

export function buildInventory(input: InvInput): InvChar[] {
  const byChar = new Map<string, InvClip[]>();
  for (const c of input.clips) {
    const a = byChar.get(c.character) ?? [];
    a.push(c); byChar.set(c.character, a);
  }
  const out: InvChar[] = [];
  for (const [character, list] of [...byChar].sort((a, b) => a[0].localeCompare(b[0]))) {
    const names = new Set(list.map((c) => c.name));
    const groups: InvGroup[] = REQUIRED.map((g) => ({
      group: g.group,
      have: g.names.filter((n) => names.has(n)),
      missing: g.names.filter((n) => !names.has(n)),
    }));

    // Дубли считаем по тройке имя+персонаж+оружие — той же, по которой ищет рантайм.
    const seen = new Map<string, number>();
    for (const c of list) { const k = `${c.name}·${c.weapon}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
    const dups = [...seen].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

    const empty = list.filter((c) => !c.keys.length).map((c) => c.name).sort();

    const broken: InvBroken[] = [];
    const states = input.anim?.[character]?.states ?? {};
    for (const st of Object.keys(states)) {
      const ref = stateClipName(st, (states as Record<string, unknown>)[st]);
      if (!names.has(ref)) broken.push({ where: `состояние «${st}»`, ref });
    }
    for (const r of input.refs ?? []) {
      if (r.character !== character) continue;
      if (!names.has(r.ref)) broken.push({ where: r.where, ref: r.ref });
    }

    const need = REQUIRED.reduce((s, g) => s + g.names.length, 0);
    out.push({
      character, total: list.length,
      done: groups.reduce((s, g) => s + g.have.length, 0), need,
      groups, dups, empty, broken,
    });
  }
  return out;
}

/** Итог одной строкой — для заголовка вкладки и для беглого взгляда. */
export function inventorySummary(rows: readonly InvChar[]): string {
  const dups = rows.reduce((s, r) => s + r.dups.reduce((q, d) => q + d.count - 1, 0), 0);
  const broken = rows.reduce((s, r) => s + r.broken.length, 0);
  const empty = rows.reduce((s, r) => s + r.empty.length, 0);
  const total = rows.reduce((s, r) => s + r.total, 0);
  return `${rows.length} персонажей · ${total} клипов`
    + (dups ? ` · ЛИШНИХ КОПИЙ ${dups}` : '')
    + (broken ? ` · битых ссылок ${broken}` : '')
    + (empty ? ` · пустых ${empty}` : '');
}
