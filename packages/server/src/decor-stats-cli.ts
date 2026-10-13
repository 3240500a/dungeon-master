import { ConfigRegistry, decorStats, formatDecorStats, type DecorStats } from '@dm/shared';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора): СВОДКА ДЕКОРА ПО СИДАМ — «документ средних» по N этажам каждого биома путём сервера
 * (`generateFloorFor` на конфиге из `packages/shared/src/config/data`, без БД и без сервера). Счёт — `dungeon/decorStats.ts`.
 *
 *   npm run decor:stats                              — 500 этажей каждого биома
 *   npm run decor:stats -- --biome=crypt --n=500     — один биом
 *   npm run decor:stats -- --biome=crypt --compare   — «до / после»: тот же биом без правил пропов (путь Ф1: паспорта россыпью) и с ними
 *   npm run decor:stats -- --biome=crypt --compare-sets — ⭐ 13.10 (Ф4) «до / после» наборов: тот же биом без правил наборов (слоты Ф2) и с ними
 *   npm run decor:stats -- --json                    — сводка JSON (без текста)
 *
 * Время сборки — после прогрева (`--warmup=20` этажей на чужих сидах); сиды и этажи выборки одни и те же у «до» и «после».
 */

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a) ?? /^--([^=]+)$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const n = Math.max(1, Math.floor(Number(args.get('n') ?? 500)));
const warmup = Math.max(0, Math.floor(Number(args.get('warmup') ?? 20)));
const only = args.get('biome');
const compare = args.has('compare') && args.get('compare') !== 'false';
const compareSets = args.has('compare-sets') && args.get('compare-sets') !== 'false';   // ⭐ 13.10 (Ф4)
const json = args.has('json') && args.get('json') !== 'false';

const reg = new ConfigRegistry();
reg.loadAll();
const biomes = reg.get('biomes').filter((b) => !only || only === 'all' || b.id === only);
if (!biomes.length) {
  console.error(`нет биома «${only}»; есть: ${reg.get('biomes').map((b) => b.id).join(', ')}`);
  process.exit(1);
}

const out: { biomeId: string; before?: DecorStats; after: DecorStats }[] = [];
for (const b of biomes) {
  const before = compareSets && b.dressing?.props?.sets ? decorStats(reg, b, { floors: n, warmup, withoutSets: true })
    : compare && b.dressing?.props ? decorStats(reg, b, { floors: n, warmup, withoutRules: true }) : undefined;
  const after = decorStats(reg, b, { floors: n, warmup });
  out.push({ biomeId: b.id, ...(before ? { before } : {}), after });
  if (!json) console.log(formatDecorStats(after, before) + '\n');
}
if (json) console.log(JSON.stringify(out, null, 2));
// сторож Р6 — отрезанное пропами с паспортом (и любой недостижимый якорь) не прощается и в сводке: код выхода 2
if (out.some((o) => o.after.cut.props.cells || o.after.cut.props.anchors || o.after.cut.other.anchors)) process.exit(2);
