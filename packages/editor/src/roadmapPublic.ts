/**
 * ПУБЛИЧНЫЙ РОАДМАП — то, что можно показать игрокам. Чистое ядро: типы, статусы, выгрузка. Без DOM.
 *
 * ЗАЧЕМ ОТДЕЛЬНО, А НЕ «ФИЛЬТР ПО РАБОЧЕМУ». Рабочий роадмап написан для команды: месячные вехи,
 * деньги, вишлисты, «⚠ этого в коде нет», оценки в неделях. Игроку из этого не нужно ничего, а часть
 * вредна (обещание даты до дня, выручка). Поэтому у публичного свой ТЕКСТ — крупными этапами и языком
 * игрока, — но СТАТУСЫ и СРОКИ он берёт из рабочего по ссылкам. Отмечать сделанное дважды не нужно,
 * а сдвиг плана кнопкой «Пересчитать» сам меняет «Осень 2027» на «Конец 2027».
 *
 * ⭐ ГРАНИЦА УТЕЧКИ — ОДНА ФУНКЦИЯ. Выгрузки (`toHtml`, `toMarkdown`, `toBBCode`) получают только
 * `ResolvedPublic` — уже разрешённые тексты и статусы. Внутренний документ до них не доходит вовсе,
 * поэтому название вехи или её описание не может просочиться «случайно». Это под тестом.
 */
import { COUNTERS, itemProgress, milestoneProgress, type Ctx, type Milestone, type RoadmapDoc, type Snapshot } from './roadmapModel.js';

export type PubStatus = 'done' | 'wip' | 'planned';

export interface PublicFeature {
  id: string;
  /** Текст для игрока. `{skillNodes}` и другие ключи `COUNTERS` подставляются числом из конфига. */
  text: string;
  /** id вех или пунктов рабочего роадмапа — из них выводится статус. */
  links?: string[];
  /** Ручной статус. Задан — перекрывает выведенный по ссылкам. */
  status?: PubStatus;
}

export interface PublicStage {
  id: string;
  title: string;
  /** Срок для игрока свободным текстом. Пусто — выводится из вехи-якоря грубым окном («Осень 2027»). */
  when?: string;
  /** Веха рабочего роадмапа, по сроку которой считается окно. Нет — берётся самая поздняя из ссылок. */
  anchor?: string;
  summary?: string;
  features: PublicFeature[];
}

export interface PublicRoadmap {
  title: string;
  intro: string;
  disclaimer: string;
  stages: PublicStage[];
}

/** Всё, что уходит наружу. Ничего из рабочего документа сюда не попадает, кроме посчитанных статусов. */
export interface ResolvedPublic {
  title: string;
  intro: string;
  disclaimer: string;
  stages: { title: string; when: string; summary: string; status: PubStatus; features: { text: string; status: PubStatus }[] }[];
}

export const STATUS_LABEL: Record<PubStatus, string> = { done: 'Готово', wip: 'В работе', planned: 'В планах' };
const STATUS_ICON: Record<PubStatus, string> = { done: '✅', wip: '🔨', planned: '🗓' };

// ── Ссылки на рабочий роадмап ────────────────────────────────────────────────────────────────────
/** Что стоит за ссылкой: веха или пункт (с вехой, в которой он лежит). */
export function resolveLink(doc: RoadmapDoc, id: string): { milestone: Milestone; itemTitle?: string; progress: (ctx: Ctx) => number } | null {
  for (const m of doc.milestones) {
    if (m.id === id) return { milestone: m, progress: (ctx) => milestoneProgress(m, ctx).ratio };
    const it = m.items.find((x) => x.id === id);
    if (it) return { milestone: m, itemTitle: it.title, progress: (ctx) => itemProgress(it, ctx) };
  }
  return null;
}

/** Ссылки, которым в рабочем роадмапе ничего не соответствует (опечатка или удалённый пункт). */
export const unknownLinks = (doc: RoadmapDoc, links: readonly string[] = []): string[] =>
  links.filter((id) => !resolveLink(doc, id));

/**
 * Статус возможности. Ручной перекрывает; иначе — средняя готовность ссылок:
 * 1 → готово, больше нуля → в работе, ноль или ссылок нет → в планах.
 */
export function featureStatus(f: PublicFeature, doc: RoadmapDoc, ctx: Ctx): PubStatus {
  if (f.status) return f.status;
  const ps = (f.links ?? []).map((id) => resolveLink(doc, id)).filter((x) => !!x).map((x) => x!.progress(ctx));
  if (!ps.length) return 'planned';
  const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  return avg >= 0.999 ? 'done' : avg > 0 ? 'wip' : 'planned';
}

export function stageStatus(list: readonly PubStatus[]): PubStatus {
  if (list.length && list.every((s) => s === 'done')) return 'done';
  return list.some((s) => s !== 'planned') ? 'wip' : 'planned';
}

// ── Сроки для игрока ─────────────────────────────────────────────────────────────────────────────
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/**
 * Грубое окно вместо даты. Игроку дата до дня — обещание, которое сорвётся; сезон — ориентир.
 * Точный месяц показываем только у внешнего события (фестиваль Steam): его дату объявляет Valve, не мы.
 */
export function roughWhen(iso: string, exactMonth = false): string {
  const y = Number(iso.slice(0, 4)), mo = Number(iso.slice(5, 7));
  if (!y || !mo) return '';
  if (exactMonth) return `${MONTHS[mo - 1]} ${y}`;
  if (mo <= 2) return `Начало ${y}`;
  if (mo <= 5) return `Весна ${y}`;
  if (mo <= 8) return `Лето ${y}`;
  if (mo <= 11) return `Осень ${y}`;
  return `Конец ${y}`;
}

/** Окно этапа: ручной текст → веха-якорь → самая поздняя веха из ссылок. */
export function stageWhen(stage: PublicStage, doc: RoadmapDoc): string {
  if (stage.when?.trim()) return stage.when.trim();
  let m: Milestone | undefined = stage.anchor ? doc.milestones.find((x) => x.id === stage.anchor) : undefined;
  if (!m) {
    for (const f of stage.features) {
      for (const id of f.links ?? []) {
        const r = resolveLink(doc, id);
        if (r && (!m || r.milestone.to > m.to)) m = r.milestone;
      }
    }
  }
  return m ? roughWhen(m.to, m.kind === 'fest') : '';
}

/** `{skillNodes}` → число из конфига. Нет конфига или ключа — знак вопроса, а не пустое место в тексте. */
export function fillCounters(text: string, config: Snapshot | undefined): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => {
    const c = COUNTERS[key];
    if (!c) return all;
    if (!config) return '?';
    try { const n = c.count(config); return n === null ? '?' : String(n); } catch { return '?'; }
  });
}

/** ЕДИНСТВЕННЫЙ мост от рабочего документа к публичному. Всё, что дальше, видит только результат. */
export function resolvePublic(pub: PublicRoadmap, doc: RoadmapDoc, ctx: Ctx): ResolvedPublic {
  return {
    title: pub.title,
    intro: fillCounters(pub.intro, ctx.config),
    disclaimer: pub.disclaimer,
    stages: pub.stages.map((s) => {
      const features = s.features
        .filter((f) => f.text.trim())
        .map((f) => ({ text: fillCounters(f.text, ctx.config), status: featureStatus(f, doc, ctx) }));
      const status = stageStatus(features.map((f) => f.status));
      return { title: s.title, when: stageWhen(s, doc), summary: fillCounters(s.summary ?? '', ctx.config), status, features };
    }),
  };
}

// ── Выгрузки ─────────────────────────────────────────────────────────────────────────────────────
const whenLine = (s: ResolvedPublic['stages'][number]): string =>
  [STATUS_ICON[s.status] + ' ' + STATUS_LABEL[s.status], s.status === 'done' ? '' : s.when].filter(Boolean).join(' · ');

/** Discord и прочие места с Markdown. */
export function toMarkdown(r: ResolvedPublic): string {
  const out: string[] = [`# ${r.title}`, '', r.intro, ''];
  for (const s of r.stages) {
    out.push(`## ${s.title}`, `*${whenLine(s)}*`);
    if (s.summary) out.push(s.summary);
    out.push('');
    for (const f of s.features) out.push(`- ${STATUS_ICON[f.status]} ${f.text}`);
    out.push('');
  }
  out.push(`_${r.disclaimer}_`);
  return out.join('\n');
}

/** Объявления и описание страницы Steam: там свой BBCode, Markdown не работает. */
export function toBBCode(r: ResolvedPublic): string {
  const out: string[] = [`[h1]${r.title}[/h1]`, r.intro, ''];
  for (const s of r.stages) {
    out.push(`[h2]${s.title}[/h2]`, `[i]${whenLine(s)}[/i]`);
    if (s.summary) out.push(s.summary);
    out.push('[list]');
    for (const f of s.features) out.push(`[*]${STATUS_ICON[f.status]} ${f.text}`);
    out.push('[/list]', '');
  }
  out.push(`[i]${r.disclaimer}[/i]`);
  return out.join('\n');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Самостоятельная страница: один файл без внешних ресурсов — её можно положить на сайт, отправить
 * ссылкой или открыть офлайн. Тот же HTML показывает превью во вкладке, поэтому видишь ровно то,
 * что уйдёт наружу.
 */
export function toHtml(r: ResolvedPublic): string {
  const stages = r.stages.map((s) => `
    <section class="stage ${s.status}">
      <div class="rail"><span class="dot"></span></div>
      <div class="card">
        <div class="meta"><span class="chip ${s.status}">${esc(STATUS_LABEL[s.status])}</span>${s.status === 'done' || !s.when ? '' : `<span class="when">${esc(s.when)}</span>`}</div>
        <h2>${esc(s.title)}</h2>
        ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ''}
        <ul>${s.features.map((f) => `<li class="${f.status}"><span class="mark" aria-label="${esc(STATUS_LABEL[f.status])}"></span>${esc(f.text)}</li>`).join('')}</ul>
      </div>
    </section>`).join('');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
  :root { --bg:#100e0c; --card:#1a1714; --edge:#2e2822; --text:#e9e2d6; --dim:#a69b8a; --brass:#c79a44; --done:#6fb383; --plan:#6d665c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:40px 16px 56px; }
  h1 { font-family:Georgia,"Times New Roman",serif; font-weight:600; font-size:clamp(28px,6vw,40px); letter-spacing:.02em; margin:0 0 8px; color:#f3ead9; }
  .intro { color:var(--dim); margin:0 0 32px; }
  .stage { display:grid; grid-template-columns:28px 1fr; gap:0 12px; }
  .rail { position:relative; display:flex; justify-content:center; }
  .rail::before { content:""; position:absolute; top:0; bottom:0; width:2px; background:var(--edge); }
  .stage:first-of-type .rail::before { top:22px; }
  .stage:last-of-type .rail::before { bottom:calc(100% - 22px); }
  .dot { position:relative; margin-top:16px; width:14px; height:14px; border-radius:50%; background:var(--bg); border:2px solid var(--plan); }
  .done .dot { background:var(--done); border-color:var(--done); }
  .wip .dot { background:var(--brass); border-color:var(--brass); box-shadow:0 0 0 5px rgba(199,154,68,.18); }
  .card { background:var(--card); border:1px solid var(--edge); border-radius:12px; padding:16px 18px; margin:0 0 16px; }
  .wip > .card { border-color:rgba(199,154,68,.45); }
  .meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px; }
  .chip { padding:2px 9px; border-radius:999px; font-weight:600; border:1px solid currentColor; }
  .chip.done { color:var(--done); } .chip.wip { color:var(--brass); } .chip.planned { color:var(--dim); }
  .when { color:var(--dim); }
  h2 { font-family:Georgia,"Times New Roman",serif; font-weight:600; font-size:21px; margin:8px 0 4px; }
  .summary { color:var(--dim); margin:0 0 8px; }
  ul { list-style:none; margin:8px 0 0; padding:0; }
  li { display:flex; gap:10px; padding:5px 0; border-top:1px solid rgba(255,255,255,.04); }
  li:first-child { border-top:0; }
  .mark { flex:none; width:16px; height:16px; margin-top:4px; border-radius:4px; border:2px solid var(--plan); }
  li.done .mark { background:var(--done); border-color:var(--done); }
  li.wip .mark { border-color:var(--brass); background:linear-gradient(90deg,var(--brass) 50%,transparent 50%); }
  li.done { color:var(--dim); }
  .disclaimer { margin-top:28px; color:var(--dim); font-size:14px; font-style:italic; }
</style>
</head>
<body>
<main>
  <h1>${esc(r.title)}</h1>
  <p class="intro">${esc(r.intro)}</p>
  ${stages}
  <p class="disclaimer">${esc(r.disclaimer)}</p>
</main>
</body>
</html>
`;
}
