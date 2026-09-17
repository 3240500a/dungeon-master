/**
 * ВИД «ДЛЯ ИГРОКОВ» во вкладке роадмапа: превью того, что увидят игроки, правка текстов и выгрузка.
 *
 * Превью — это ТОТ ЖЕ HTML, что уходит в файл (`toHtml` в iframe), а не отдельная вёрстка: иначе
 * «в редакторе красиво» и «на сайте криво» разъедутся с первой правки стилей.
 * Математика и граница утечки живут в `roadmapPublic.ts` (под тестами) — здесь только DOM.
 */
import {
  resolvePublic, stageWhen, unknownLinks, resolveLink, toHtml, toMarkdown, toBBCode, STATUS_LABEL,
  type PublicRoadmap, type PublicStage, type PublicFeature, type PubStatus,
} from './roadmapPublic.js';
import { newId, type Ctx, type RoadmapDoc } from './roadmapModel.js';
import { PUBLIC_SEED } from './roadmapSeed.js';

const C = { bg: '#1c1c26', edge: '#2c2c3a', text: '#e8e8f0', dim: '#9a9ab0', faint: '#6f6f88', active: '#c79a44', over: '#d4634a', done: '#5fbf7f' };
const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e;
};
const btn = (label: string, fn: () => void, css = ''): HTMLButtonElement => {
  const b = document.createElement('button'); b.textContent = label;
  b.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:6px;border:1px solid ${C.edge};background:${C.bg};color:${C.text};font-size:12px;${css}`;
  b.addEventListener('click', fn); return b;
};
const INP = `background:#0f0f16;border:1px solid ${C.edge};border-radius:5px;color:${C.text};padding:5px 7px;font:inherit;font-size:13px`;

/** Правка открыта или нет — личное состояние вкладки, в документ не пишется. */
let editing = false;

function input(value: string, css: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.value = value; i.placeholder = placeholder; i.style.cssText = INP + ';' + css;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function area(value: string, rows: number, onChange: (v: string) => void): HTMLTextAreaElement {
  const t = document.createElement('textarea');
  t.value = value; t.rows = rows; t.style.cssText = INP + ';width:100%;resize:vertical';
  t.addEventListener('change', () => onChange(t.value));
  return t;
}

async function copy(text: string, b: HTMLButtonElement): Promise<void> {
  const was = b.textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = 'скопировано ✓'; }
  catch {
    // Буфер обмена недоступен (нет фокуса/разрешения) — выделяем текст, чтобы скопировать руками.
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); b.textContent = 'скопировано ✓'; } catch { b.textContent = 'не вышло'; }
    t.remove();
  }
  setTimeout(() => { b.textContent = was; }, 1600);
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderPublicView(doc: RoadmapDoc, ctx: Ctx, onChange: () => void): HTMLElement {
  const wrap = el('div', 'display:flex;flex-direction:column;gap:12px');
  const pub = doc.public;
  if (!pub) {
    const box = el('div', `border:1px dashed ${C.edge};border-radius:10px;padding:24px;text-align:center;color:${C.dim}`);
    box.appendChild(el('div', 'margin-bottom:12px', 'Роадмапа для игроков пока нет.'));
    box.appendChild(btn('Создать из заготовки', () => { doc.public = PUBLIC_SEED(); onChange(); }));
    wrap.appendChild(box);
    return wrap;
  }
  const resolved = resolvePublic(pub, doc, ctx);

  // ── Панель: что это и куда выгрузить ──
  const bar = el('div', `border:1px solid ${C.edge};border-radius:10px;padding:12px 14px;background:#16161f;display:flex;gap:10px;align-items:center;flex-wrap:wrap`);
  const note = el('div', `flex:1;min-width:260px;color:${C.dim};font-size:12px;line-height:1.5`,
    'Так роадмап увидят игроки. Статусы и сроки считаются из рабочего плана по ссылкам — отмечать сделанное '
    + 'второй раз не нужно. Наружу уходят только тексты этой страницы: вехи, цифры, деньги и заметки команды не попадают.');
  bar.appendChild(note);
  bar.appendChild(btn(editing ? '✓ Готово' : '✎ Править тексты', () => { editing = !editing; onChange(); },
    editing ? `border-color:${C.done};color:${C.done}` : ''));
  const bSteam = btn('📋 Steam', () => { void copy(toBBCode(resolvePublic(pub, doc, ctx)), bSteam); });
  bSteam.title = 'BBCode для объявления или описания страницы в Steam';
  const bDiscord = btn('📋 Discord', () => { void copy(toMarkdown(resolvePublic(pub, doc, ctx)), bDiscord); });
  bDiscord.title = 'Markdown для Discord, Reddit и девлога';
  const bHtml = btn('⬇ HTML-страница', () => download('roadmap.html', toHtml(resolvePublic(pub, doc, ctx))));
  bHtml.title = 'Один файл без внешних ресурсов — можно положить на сайт';
  bar.append(bSteam, bDiscord, bHtml);
  wrap.appendChild(bar);

  if (editing) wrap.appendChild(renderEditor(pub, doc, onChange));

  // ── Превью: ровно тот HTML, что уйдёт в файл ──
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');   // скрипты не нужны, а высоту документа читать надо
  frame.style.cssText = `width:100%;border:1px solid ${C.edge};border-radius:10px;background:#100e0c;height:600px`;
  frame.srcdoc = toHtml(resolved);
  // Высота по BODY и с наблюдателем, а не разовым замером `documentElement`: тот не бывает меньше окна
  // iframe, и если первый замер пришёлся на узкую ещё не разложенную рамку (8025 px вместо 2693), рамка
  // навсегда оставалась с пустым хвостом. Высота тела от высоты рамки не зависит — петли нет.
  frame.addEventListener('load', () => {
    const body = frame.contentDocument?.body;
    if (!body) return;
    const fit = (): void => { frame.style.height = body.scrollHeight + 'px'; };
    new ResizeObserver(fit).observe(body);
    fit();
  });
  wrap.appendChild(frame);
  return wrap;
}

function renderEditor(pub: PublicRoadmap, doc: RoadmapDoc, onChange: () => void): HTMLElement {
  const box = el('div', `border:1px solid ${C.edge};border-radius:10px;padding:14px;background:#16161f;display:flex;flex-direction:column;gap:10px`);
  const label = (t: string): HTMLElement => el('div', `color:${C.faint};font-size:11px;text-transform:uppercase;letter-spacing:.06em`, t);

  box.appendChild(label('Заголовок'));
  box.appendChild(input(pub.title, 'width:100%;font-size:15px;font-weight:600', (v) => { pub.title = v; onChange(); }));
  box.appendChild(label('Вступление'));
  box.appendChild(area(pub.intro, 2, (v) => { pub.intro = v; onChange(); }));
  box.appendChild(label('Оговорка внизу'));
  box.appendChild(area(pub.disclaimer, 2, (v) => { pub.disclaimer = v; onChange(); }));
  box.appendChild(el('div', `color:${C.faint};font-size:11px`,
    'В тексте можно писать {skillNodes}, {masteryNodes}, {monsters}, {uniques}, {itemsBase} — подставится число из конфига.'));

  pub.stages.forEach((s, si) => box.appendChild(renderStageEditor(s, si, pub, doc, onChange)));
  box.appendChild(btn('+ этап', () => {
    pub.stages.push({ id: newId('stage'), title: 'Новый этап', features: [] }); onChange();
  }, 'align-self:flex-start'));
  return box;
}

function renderStageEditor(s: PublicStage, si: number, pub: PublicRoadmap, doc: RoadmapDoc, onChange: () => void): HTMLElement {
  const card = el('div', `border:1px solid ${C.edge};border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px`);
  const top = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap');
  top.appendChild(input(s.title, 'flex:1;min-width:220px;font-weight:600', (v) => { s.title = v; onChange(); }, 'название этапа'));

  // Срок: пустое поле = считать из вехи. Подсказка показывает, что посчитается, — иначе непонятно, зачем его трогать.
  const auto = stageWhen({ ...s, when: '' }, doc);
  top.appendChild(input(s.when ?? '', 'width:130px', (v) => { s.when = v.trim() || undefined; onChange(); }, auto ? `авто: ${auto}` : 'срок'));
  const anchor = document.createElement('select');
  anchor.style.cssText = INP + ';width:190px';
  anchor.title = 'Веха рабочего плана, по сроку которой считается окно для игрока';
  anchor.appendChild(new Option('срок: по поздней ссылке', ''));
  for (const m of doc.milestones) anchor.appendChild(new Option(`${m.id} · ${m.title}`, m.id, false, m.id === s.anchor));
  anchor.addEventListener('change', () => { s.anchor = anchor.value || undefined; onChange(); });
  top.appendChild(anchor);

  const move = (d: number): void => {
    const j = si + d; if (j < 0 || j >= pub.stages.length) return;
    [pub.stages[si], pub.stages[j]] = [pub.stages[j]!, pub.stages[si]!]; onChange();
  };
  top.appendChild(btn('↑', () => move(-1)));
  top.appendChild(btn('↓', () => move(1)));
  top.appendChild(btn('✕', () => {
    if (!confirm(`Удалить этап «${s.title}»?`)) return;
    pub.stages = pub.stages.filter((x) => x !== s); onChange();
  }, `color:${C.faint};border-color:transparent;background:transparent`));
  card.appendChild(top);
  card.appendChild(input(s.summary ?? '', 'width:100%', (v) => { s.summary = v || undefined; onChange(); }, 'одна-две фразы: что этот этап даёт игроку'));

  for (const f of s.features) card.appendChild(renderFeatureEditor(f, s, doc, onChange));
  card.appendChild(btn('+ возможность', () => { s.features.push({ id: newId('feat'), text: '' }); onChange(); }, 'align-self:flex-start;font-size:11px'));
  return card;
}

function renderFeatureEditor(f: PublicFeature, s: PublicStage, doc: RoadmapDoc, onChange: () => void): HTMLElement {
  const row = el('div', `display:flex;flex-direction:column;gap:3px;padding:6px 0 6px 10px;border-left:2px solid ${C.edge}`);
  const line = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap');
  line.appendChild(input(f.text, 'flex:1;min-width:260px', (v) => { f.text = v; onChange(); }, 'что получит игрок'));

  const st = document.createElement('select');
  st.style.cssText = INP + ';width:130px';
  st.appendChild(new Option('статус: авто', '', false, !f.status));
  for (const k of ['done', 'wip', 'planned'] as PubStatus[]) st.appendChild(new Option(STATUS_LABEL[k], k, false, f.status === k));
  st.addEventListener('change', () => { f.status = (st.value || undefined) as PubStatus | undefined; onChange(); });
  line.appendChild(st);
  line.appendChild(input((f.links ?? []).join(', '), 'width:200px;font-size:12px', (v) => {
    const ids = v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    f.links = ids.length ? ids : undefined; onChange();
  }, 'ссылки: м03, m3-15'));
  line.appendChild(btn('✕', () => { s.features = s.features.filter((x) => x !== f); onChange(); },
    `color:${C.faint};border-color:transparent;background:transparent`));
  row.appendChild(line);

  // Во что упираются ссылки — иначе статус «в планах» при опечатке выглядит как правда.
  const links = f.links ?? [];
  if (links.length) {
    const bad = new Set(unknownLinks(doc, links));
    const hint = el('div', `color:${C.faint};font-size:11px;line-height:1.4`);
    hint.textContent = links.map((id) => {
      if (bad.has(id)) return `✗ ${id} — нет такого`;
      const r = resolveLink(doc, id)!;
      return `${id}: ${r.itemTitle ?? r.milestone.title}`;
    }).join(' · ');
    if (bad.size) hint.style.color = C.over;
    row.appendChild(hint);
  }
  return row;
}
