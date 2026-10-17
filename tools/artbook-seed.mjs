/**
 * ⭐ 16.10 (Артбук): ИМПОРТ ЧЕРНОВИКА В СИД вкладки «🎨 Артбук» редактора конфигов.
 *
 *   node tools/artbook-seed.mjs <путь к draft.json>       — черновик крипты → seed/crypt.json
 *   node tools/artbook-seed.mjs --v2 <папка ростеров>     — ростеры по ярусам (v2) → seed/v2/<подтип>.json + seed/v2/index.json
 *
 * Черновик (сборка исследований по нежити крипты) кладётся как есть в `packages/editor/src/artbook/seed/crypt.json` — с
 * отступом в один пробел и LF, чтобы следующий импорт давал читаемый дифф. Правки владельца живут отдельно (`pe_artbook`,
 * по пути поля) и новым сидом НЕ затираются: поля, которых он не трогал, поедут с сидом, тронутые — останутся его, а там, где
 * сид под правкой поменялся, вкладка покажет «сид обновился».
 *
 * Проверяет форму до записи: подтипы с уникальными id латиницей и номерами владельца (сколько их — решает черновик; с 16.10
 * их шесть), у архетипов — известные подтипы, у матрицы — колонки подтипов, у таблиц по подтипам — известные подтипы, ключи
 * строк в каждой таблице уникальны (путь правки держится за ключ). Кривой черновик не пишется (иначе вкладка открылась бы
 * пустой).
 *
 * ⭐ 17.10 РОСТЕРЫ v2 (`--v2`): в папке — по файлу на подтип (`<что угодно>.json` с полем `id` подтипа и `tiers`) и, по желанию,
 * `part2.json` — тексты «Части 2 · Ярусы и архетипы» (уходят в index.json как есть). Ростер НОРМАЛИЗУЕТСЯ: у строк таблиц без
 * ключа появляется `id` (состав пачки — id карточки, комплект моделей — ярус, «куда ушли прежние карточки» — id архетипа
 * архива, идеи банка и подписи — транслит имени, полосы перехода — полоса), из текста снимается markdown-жирный `**`.
 * Проверки: подтип есть в crypt.json, ярусы light / medium / heavy и на каждом 3 ближника + 2 стрелка, 3 босса на этажах
 * 5 / 14 / 19, 4–6 особых, id карточек уникальны по всему ростеру, состав пачек — только свои карточки, родной статус — самый
 * частый по карточкам, ключи строк уникальны. Общие таблицы (переход ярусов, стойкость по ярусу, множители статусов) обязаны
 * совпасть у всех подтипов — они одни на крипту и лежат в index.json.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'editor', 'src', 'artbook', 'seed');
const ROW_KEYS = ['id', 'subtype', 'code'];
const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 1) + '\n', 'utf8');

let problems = [];
const fail = (m) => problems.push(m);
const stopIfBad = (what) => {
  if (!problems.length) return;
  console.error(`${what} не годится:\n  - ` + problems.join('\n  - '));
  process.exit(1);
};

/** Каждый массив объектов: ключ строки (первый из id / subtype / code) уникален и не число. `strict` — ключ обязан быть у каждой строки. */
function rowKeyProblems(x, path = '', strict = false) {
  const out = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      const rows = v.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (rows.length) {
        const k = ROW_KEYS.find((key) => rows.some((r) => typeof r[key] === 'string'));
        if (!k) { if (strict) out.push(`${p}: у строк нет ключа (${ROW_KEYS.join(' / ')})`); }
        else {
          const keys = rows.map((r) => r[k]);
          if (strict && keys.some((s) => typeof s !== 'string')) out.push(`${p}: не у всех строк есть ${k}`);
          const str = keys.filter((s) => typeof s === 'string');
          const dup = str.filter((s, i) => str.indexOf(s) !== i);
          if (dup.length) out.push(`${p}: повтор ${k} ${[...new Set(dup)].join(', ')}`);
          if (str.some((s) => /^\d+$/.test(s))) out.push(`${p}: ключ-число спутается с индексом`);
        }
      }
      v.forEach((r, i) => walk(r, `${p}/${i}`));
    } else if (v && typeof v === 'object') for (const [key, val] of Object.entries(v)) walk(val, p ? `${p}/${key}` : key);
  };
  walk(x, path);
  return out;
}

// ── черновик крипты ──────────────────────────────────────────────────────────────────────────────

function importCrypt(src) {
  const d = JSON.parse(readFileSync(src, 'utf8'));
  if (!Array.isArray(d.subtypes) || !d.subtypes.length) fail('нет subtypes');
  const list = d.subtypes ?? [];
  const ids = new Set(list.map((s) => s.id));
  if (ids.size !== list.length) fail('повтор id подтипа');
  if ([...ids].some((id) => typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id))) fail('id подтипа не латиницей');
  const nos = list.map((s) => s.ownerNo);
  if (nos.some((n) => !Number.isInteger(n)) || new Set(nos).size !== nos.length) fail('номера владельца (ownerNo) не целые или повторяются');
  if (!Array.isArray(d.archetypes)) fail('нет archetypes');
  for (const a of d.archetypes ?? []) {
    if (typeof a.id !== 'string') fail('архетип без id');
    for (const s of a.subtypes ?? []) if (!ids.has(s)) fail(`архетип ${a.id}: неизвестный подтип ${s}`);
  }
  for (const c of d.matrix?.columns ?? []) if (!ids.has(c.id)) fail(`матрица: неизвестная колонка ${c.id}`);
  const bySub = [['decayLadder', d.decayLadder?.rows], ['statuses', d.statuses?.rows], ['signatures', d.signatures?.rows], ['readability.keys', d.readability?.keys]];
  for (const [name, rows] of bySub) for (const r of rows ?? []) if (!ids.has(r.subtype)) fail(`${name}: неизвестный подтип ${r.subtype}`);
  if (!Array.isArray(d.selection?.rules) || !d.selection.rules.length) fail('нет selection.rules (выбор подтипа при спуске)');
  for (const p of rowKeyProblems(d)) fail(p);
  stopIfBad('черновик');
  const out = join(SEED, 'crypt.json');
  write(out, d);
  console.log(`сид записан: ${out} — подтипов ${d.subtypes.length}, архетипов ${d.archetypes.length}`);
}

// ── ростеры v2 ───────────────────────────────────────────────────────────────────────────────────

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/** Ключ строки из имени: до скобки, «;» или тире, транслитом, латиница и `_`, не длиннее 40. */
function slug(name) {
  const head = String(name).split(/\s*[(;]|\s+—\s+/)[0].toLowerCase();
  const lat = [...head].map((ch) => TR[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let s = lat.length > 40 ? lat.slice(0, 40).replace(/_[^_]*$/, '') : lat;
  if (!s) s = 'row';
  return /^\d/.test(s) ? 'n' + s : s;
}
/** Раздать ключи строкам массива: `want(row)` — желаемый ключ; повтор получает `_2`, `_3`… Ключ встаёт первым полем. */
function giveIds(rows, want) {
  const seen = new Map();
  return rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    if (ROW_KEYS.some((k) => typeof r[k] === 'string')) return r;
    const base = want(r);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const { id: _drop, ...rest } = r;
    return { id: n === 1 ? base : `${base}_${n}`, ...rest };
  });
}
const KIT_IDS = { 'Общее (все ярусы)': 'common', 'Лёгкий': 'light', 'Средний': 'medium', 'Тяжёлый': 'heavy', 'Боссы и особые': 'bossesSpecials' };
const TIERS = ['light', 'medium', 'heavy'];

/** Снять markdown-жирный во всех строках (в сиде — простой текст; пометки `[есть]` и `коды` остаются). */
function plain(x) {
  if (typeof x === 'string') return x.replace(/\*\*/g, '');
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}

function normalizeRoster(src, crypt) {
  const r = plain(src);
  const sub = r.id;
  const cardIds = new Map();
  for (const t of r.tiers ?? []) for (const c of t.cards ?? []) cardIds.set(c.name, c.id);
  for (const s of r.specials ?? []) cardIds.set(s.name, s.id);
  for (const b of r.bosses ?? []) cardIds.set(b.name, b.id);
  for (const p of r.packs ?? []) {
    const byName = (m) => cardIds.get(m.card) ?? slug(m.card);
    p.members = giveIds(p.members ?? [], byName);
    if (Array.isArray(p.optional)) p.optional = giveIds(p.optional, byName);
  }
  r.kit = giveIds(r.kit ?? [], (k) => KIT_IDS[k.tier] ?? slug(k.tier));
  // «куда ушли прежние карточки»: ключ — id архетипа архива (crypt.json), у кого его нет — транслит имени
  const archOf = new Map();
  for (const a of crypt.archetypes ?? []) {
    const v = a.perSubtype?.[sub];
    if (v?.name) archOf.set(v.name, a.id);
    if (a.subtypes?.length === 1 && a.subtypes[0] === sub) archOf.set(a.name, a.id);
  }
  r.migration = giveIds(r.migration ?? [], (m) => archOf.get(m.was) ?? slug(m.was));
  if (r.ideaBank) r.ideaBank.ideas = giveIds(r.ideaBank.ideas ?? [], (i) => slug(i.name));
  if (r.transition) r.transition.bands = giveIds(r.transition.bands ?? [], (b) => b.band);
  if (Array.isArray(r.rules?.signatures)) r.rules.signatures = giveIds(r.rules.signatures, (s) => slug(s.name));
  return r;
}

function checkRoster(r, ids) {
  const w = (m) => fail(`${r.id}: ${m}`);
  if (!ids.includes(r.id)) w('подтипа нет в crypt.json');
  const tiers = r.tiers ?? [];
  if (tiers.map((t) => t.id).join() !== TIERS.join()) w(`ярусы ${tiers.map((t) => t.id).join(', ')} вместо ${TIERS.join(', ')}`);
  for (const t of tiers) {
    const melee = (t.cards ?? []).filter((c) => c.combat === 'melee').length;
    const ranged = (t.cards ?? []).filter((c) => c.combat === 'ranged').length;
    if (melee !== 3 || ranged !== 2 || t.cards.length !== 5) w(`ярус ${t.id}: ${melee} ближн. + ${ranged} стрелк. из ${t.cards?.length} (нужно 3 + 2)`);
  }
  const floors = (r.bosses ?? []).map((b) => b.floor).join();
  if (floors !== '5,14,19') w(`боссы на этажах ${floors} (нужно 5, 14, 19)`);
  const ns = (r.specials ?? []).length;
  if (ns < 4 || ns > 6) w(`особых ${ns} (нужно 4–6)`);
  const all = [...tiers.flatMap((t) => t.cards ?? []), ...(r.specials ?? []), ...(r.bosses ?? [])].map((c) => c.id);
  const dup = all.filter((x, i) => all.indexOf(x) !== i);
  if (dup.length) w(`повтор id карточки: ${[...new Set(dup)].join(', ')}`);
  const known = new Set(all);
  for (const p of r.packs ?? []) for (const m of [...(p.members ?? []), ...(p.optional ?? [])]) if (!known.has(m.id)) w(`пачка ${p.id}: «${m.card}» — не карточка подтипа`);
  const sc = r.statusCount?.cards ?? {};
  const top = Object.entries(sc).sort((a, b) => b[1] - a[1]);
  const native = r.rules?.statuses?.native?.status;
  if (!top.length || top[0][0] !== native || (top[1] && top[1][1] === top[0][1])) w(`родной статус «${native}» — не самый частый по карточкам (${top.map(([k, v]) => `${k} ${v}`).join(', ')})`);
  for (const b of r.transition?.bands ?? []) if (b.light + b.medium + b.heavy !== 100) w(`полоса ${b.band}: доли ярусов не дают 100 %`);
  for (const p of rowKeyProblems(r, r.id, true)) w(p);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function importV2(dir) {
  const crypt = JSON.parse(readFileSync(join(SEED, 'crypt.json'), 'utf8'));
  const order = crypt.subtypes.map((s) => s.id);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'part2.json');
  const rosters = new Map();
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!Array.isArray(raw.tiers)) { console.log(`пропущен ${f}: нет tiers`); continue; }
    const r = normalizeRoster(raw, crypt);
    if (rosters.has(r.id)) fail(`${f}: второй ростер подтипа ${r.id}`);
    rosters.set(r.id, r);
    checkRoster(r, order);
  }
  for (const id of order) if (!rosters.has(id)) fail(`нет ростера подтипа ${id}`);
  // общие на крипту таблицы — одинаковы у всех
  const first = rosters.get(order[0]);
  const shares = (r) => ({
    bands: (r.transition?.bands ?? []).map((b) => [b.band, b.floors, b.light, b.medium, b.heavy]),
    tierResist: { light: r.rules?.tierResist?.light, medium: r.rules?.tierResist?.medium, heavy: r.rules?.tierResist?.heavy },
    mults: [r.rules?.statuses?.native?.mult, r.rules?.statuses?.second?.mult, r.rules?.statuses?.foreign?.mult],
  });
  if (first) for (const [id, r] of rosters) for (const [k, v] of Object.entries(shares(r))) if (!same(v, shares(first)[k])) fail(`${id}: ${k} не как у ${first.id} (таблица общая на крипту)`);
  let part2 = {};
  try { part2 = JSON.parse(readFileSync(join(dir, 'part2.json'), 'utf8')); } catch { /* текстов Части 2 нет — индекс без них */ }
  if (first && part2.transition?.bands) {
    const doc = part2.transition.bands.map((b) => [b.id, b.floors, b.light, b.medium, b.heavy]);
    if (!same(doc, shares(first).bands)) fail('part2.json: таблица перехода не как в ростерах');
  }
  if (first && part2.tierResist?.rows) {
    const pick = (row) => Object.fromEntries(['slashing', 'piercing', 'crushing', 'lightning'].filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
    for (const row of part2.tierResist.rows) if (!same(pick(row), first.rules.tierResist[row.id])) fail(`part2.json: стойкость яруса ${row.id} не как в ростерах`);
  }
  stopIfBad('ростеры v2');

  const out = join(SEED, 'v2');
  mkdirSync(out, { recursive: true });
  const name = new Map(crypt.subtypes.map((s) => [s.id, s]));
  const summary = [];
  for (const id of order) {
    const r = rosters.get(id);
    write(join(out, `${id}.json`), r);
    const cards = r.tiers.flatMap((t) => t.cards);
    summary.push({
      id, name: name.get(id).name, ownerNo: name.get(id).ownerNo, file: `${id}.json`, title: r.title,
      native: r.rules.statuses.native, second: r.rules.statuses.second,
      counts: {
        cards: cards.length, melee: cards.filter((c) => c.combat === 'melee').length, ranged: cards.filter((c) => c.combat === 'ranged').length,
        bosses: r.bosses.length, specials: r.specials.length, specialsWave1: r.specials.filter((s) => s.wave === 1).length,
        packs: r.packs.length, newGear: r.newGear?.length ?? 0, kit: r.kit.length,
        bankBosses: r.ideaBank?.bosses?.length ?? 0, bankIdeas: r.ideaBank?.ideas?.length ?? 0, openQuestions: r.openQuestions?.length ?? 0,
      },
    });
  }
  const index = {
    version: 'v2',
    date: first?.date ?? '',
    note: 'Ростеры по ярусам (решения владельца 17.10): карточки ярусов, боссы, особые, пачки, комплект моделей и банк идей — в '
      + 'seed/v2/<подтип>.json, по файлу на подтип (грузятся лениво). Здесь — сводка и общие на крипту таблицы.',
    order,
    subtypes: summary,
    statusMults: { native: first.rules.statuses.native.mult, second: first.rules.statuses.second.mult, foreign: first.rules.statuses.foreign.mult },
    tierResistMult: { light: first.rules.tierResist.light, medium: first.rules.tierResist.medium, heavy: first.rules.tierResist.heavy },
    ...part2,
  };
  for (const p of rowKeyProblems(index, 'index', true)) fail(p);
  stopIfBad('индекс v2');
  write(join(out, 'index.json'), index);
  console.log(`ростеры v2 записаны: ${out} — ${order.map((id) => `${id} ${summary.find((s) => s.id === id).counts.cards}+${rosters.get(id).bosses.length}+${rosters.get(id).specials.length}`).join(', ')}`);
}

const [arg, arg2] = process.argv.slice(2);
if (arg === '--v2') {
  if (!arg2) { console.error('нужна папка ростеров: --v2 <папка>'); process.exit(2); }
  importV2(arg2);
} else {
  if (!arg) { console.error('нужен путь к draft.json (или --v2 <папка>)'); process.exit(2); }
  importCrypt(arg);
}
