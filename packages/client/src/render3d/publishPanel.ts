/**
 * ПУБЛИКАЦИЯ рабочей копии на сервер (Ф12.3): кнопка в тулбаре + окно со списком изменений.
 *
 * Модель — из Unreal: изменённое помечено (там `bDirty` и звёздочка в заголовке), а сохранение — ОСОЗНАННОЕ
 * действие (`Save Dirty Packages` / Save All). Автосейв там же считается «резервной копией, а не заменой
 * явному сохранению»; у нас роль автосейва играет рабочая копия в localStorage, которую никто не затирает.
 *
 * Три состояния кнопки, и все три нужны:
 *  • `⬆ Опубликовать (N)` — есть неопубликованные правки;
 *  • `✓ Опубликовано` — расхождений нет;
 *  • `⟳ на сервере новее` — кто-то (вторая вкладка/машина) опубликовал раньше нас; жать не обязательно,
 *    но видно СРАЗУ, а не постфактум по пропавшему клипу.
 */
import { dirtyKeys, serverAheadKeys, publish, pullFromServer, refreshServerRevs, onSyncChange, wipeAll } from './poseServer.js';

/** Человеческие имена ключей: «pe_clips» ничего не говорит, «клипы и кадры» — говорит. */
const LABEL: Record<string, string> = {
  pe_clips: 'клипы и кадры', pe_gait: 'походка', pe_sway: 'покачивание', pe_phys: 'физика (мышцы/пины)',
  pe_ragdoll: 'суставы и физ-тела', pe_chars: 'свои персонажи', pe_attacks: 'удары', pe_loco: 'локомоция',
  pe_appearance: 'внешний вид', pe_shield: 'щит', pe_twist: 'скрутка корпуса', pe_models: '3D-модели',
  pe_grip: 'хват оружия', pe_gripposes: 'позы хвата', pe_morph: 'телосложение', pe_morph_range: 'разброс тел',
  pe_poselib: 'библиотека поз', pe_ai: 'настройки ИИ', pe_bonemaps: 'карты костей', pe_ui: 'вид панелей',
  pe_config: 'модели и материалы (конфиг)',
};
export const keyLabel = (k: string): string => {
  if (k.startsWith('pe_config:')) {                       // правки конфига приходят как `pe_config:<секция>`
    const sec = k.slice('pe_config:'.length);
    return ({ models: '3D-модели и сабмеши', materials: 'материалы', textures: 'текстуры' } as Record<string, string>)[sec] ?? 'конфиг: ' + sec;
  }
  return LABEL[k] ?? k;
};

const CSS = {
  btn: 'margin:0 3px;padding:3px 9px;background:#2a3350;color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace',
  primary: 'margin:0 3px;padding:3px 9px;background:#2f5a34;color:#dfe8d8;border:1px solid #4a7a50;border-radius:4px;cursor:pointer;font:11px monospace',
};

export interface PublishButton {
  el: HTMLButtonElement;
  refresh(): void;
  dispose(): void;
}

/**
 * Кнопка публикации для тулбара. `extraDirty` — источники правок вне `pe_*` (конфиг моделей живёт своим
 * слоем, но публиковаться должен ТОЙ ЖЕ кнопкой: две кнопки «сохранить» — это ровно та путаница,
 * на которую жалуется юзер).
 */
export function createPublishButton(opts: {
  extraDirty?: () => string[];
  publishExtra?: () => Promise<{ ok: boolean; error?: string }>;
  onDone?: () => void;
} = {}): PublishButton {
  const b = document.createElement('button');
  b.className = 'tbtn';
  let busy = false;

  const extra = (): string[] => { try { return opts.extraDirty?.() ?? []; } catch { return []; } };

  function refresh(): void {
    if (busy) return;
    const dirty = [...dirtyKeys(), ...extra()];
    const ahead = serverAheadKeys();
    if (dirty.length) {
      b.textContent = `⬆ Опубликовать (${dirty.length})`;
      b.title = 'Не опубликовано: ' + dirty.map(keyLabel).join(', ') + '\nПравки хранятся локально и не пропадут; на сервер уходят только по этой кнопке.';
      b.classList.add('on');
    } else if (ahead.length) {
      b.textContent = '⟳ на сервере новее';
      b.title = 'Кто-то опубликовал раньше: ' + ahead.map(keyLabel).join(', ') + '\nНажми, чтобы забрать серверную версию.';
      b.classList.remove('on');
    } else {
      b.textContent = '✓ Опубликовано';
      b.title = 'Локальное и серверное совпадают.';
      b.classList.remove('on');
    }
  }

  b.onclick = () => { void openDialog(); };

  async function openDialog(): Promise<void> {
    if (busy) return;
    busy = true; b.textContent = '… проверяю сервер';
    const online = await refreshServerRevs();
    busy = false; refresh();
    showDialog(online, refresh, opts);
  }

  const off = onSyncChange(refresh);
  refresh();
  return { el: b, refresh, dispose: () => off() };
}

/** Окно публикации: что изменено, что на сервере новее, и две понятные кнопки. */
function showDialog(online: boolean, refresh: () => void, opts: { publishExtra?: () => Promise<{ ok: boolean; error?: string }>; extraDirty?: () => string[]; onDone?: () => void }): void {
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:60;display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'min-width:420px;max-width:560px;max-height:70vh;overflow:auto;background:#171a22;border:1px solid #39415a;border-radius:8px;padding:14px;color:#dfe3ee;font:12px monospace';
  back.append(box);
  const close = (): void => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };

  const render = (status = ''): void => {
    box.textContent = '';
    const dirty = [...dirtyKeys(), ...(opts.extraDirty?.() ?? [])];
    const ahead = serverAheadKeys();

    const h = document.createElement('div');
    h.style.cssText = 'font-size:13px;margin-bottom:8px';
    h.textContent = 'Публикация на сервер';
    box.append(h);

    const note = document.createElement('div');
    note.style.cssText = 'color:#8b93a7;margin-bottom:10px;line-height:1.5';
    note.textContent = online
      ? 'Правки всегда хранятся локально и переживают перезагрузку. На сервер (и значит в игру и второй машине) они уходят только отсюда.'
      : '⚠ Сервер недоступен. Работать можно дальше — всё лежит локально; опубликуешь, когда сервер поднимется.';
    box.append(note);

    const list = (title: string, keys: string[], color: string): void => {
      if (!keys.length) return;
      const t = document.createElement('div'); t.style.cssText = `color:${color};margin:8px 0 3px`; t.textContent = title; box.append(t);
      for (const k of keys) {
        const r = document.createElement('div'); r.style.cssText = 'padding:2px 0 2px 12px'; r.textContent = '• ' + keyLabel(k); box.append(r);
      }
    };
    const both = dirty.filter((k) => ahead.includes(k));
    list('Не опубликовано:', dirty.filter((k) => !both.includes(k)), '#d8c07a');
    list('На сервере новее (правил кто-то другой):', ahead.filter((k) => !both.includes(k)), '#7aa8d8');
    // Расхождение: правили и мы, и кто-то ещё. Показываем ОТДЕЛЬНО — иначе раздел висит в двух списках сразу
    // и непонятно, что вообще произойдёт по кнопке.
    list('⚠ Расходятся (правил и ты, и кто-то ещё) — публикация такого будет отклонена, сначала забери серверное:', both, '#d8907a');
    if (!dirty.length && !ahead.length) {
      const ok = document.createElement('div'); ok.style.cssText = 'color:#8fc98f;margin:6px 0'; ok.textContent = '✓ Всё совпадает — публиковать нечего.'; box.append(ok);
    }

    if (status) { const s = document.createElement('div'); s.style.cssText = 'margin-top:10px;color:#cfd3e0'; s.textContent = status; box.append(s); }

    const row = document.createElement('div'); row.style.cssText = 'margin-top:14px;display:flex;justify-content:flex-end;gap:4px';
    if (dirty.length && online) {
      const go = document.createElement('button'); go.style.cssText = CSS.primary; go.textContent = '⬆ Опубликовать';
      go.onclick = () => { void doPublish(render, opts); };
      row.append(go);
    }
    if (ahead.length && online) {
      const pull = document.createElement('button'); pull.style.cssText = CSS.btn; pull.textContent = '⬇ Забрать серверное';
      pull.title = 'Заменит локальную версию перечисленных разделов серверной. Единственное место, где серверное перезаписывает твоё, — и только по этой кнопке.';
      pull.onclick = () => { void doPull(ahead, render, opts); };
      row.append(pull);
    }
    const cancel = document.createElement('button'); cancel.style.cssText = CSS.btn; cancel.textContent = 'закрыть';
    cancel.onclick = close; row.append(cancel);
    box.append(row);
    // ── ЧИСТЫЙ ЛИСТ ───────────────────────────────────────────────────────────────────────────
    // Настройки копятся в десятке ключей, живут в трёх местах и переживают удаление модели — поэтому
    // «загрузил заново, а садится как раньше» выглядит мистикой. Отдельной кнопки для этого не было,
    // а вручную по ключу вычистить нельзя: их не видно. Стоит ВНИЗУ и спрашивает дважды.
    const danger = document.createElement('div');
    danger.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #4a3040';
    const db = document.createElement('button');
    db.style.cssText = CSS.btn + ';background:#4a2230;border-color:#7a3a4a;color:#e8cdd4';
    db.textContent = '🗑 чистый лист (стереть весь контент)';
    db.onclick = () => {
      const what = [
        'СТЕРЕТЬ ВЕСЬ АВТОРСКИЙ КОНТЕНТ?', '',
        'Уйдут: все клипы и кадры, походка, хват, физика, настройки',
        'контроллера, свои персонажи И их 3D-атласы — и в рабочей',
        'копии, и НА СЕРВЕРЕ.', '',
        'Модели окружения (пол, стены, декор) и оружие НЕ стираются.',
        'Личные настройки инструмента (вид панелей) останутся.',
      ].join('\n');
      if (!confirm(what)) return;
      if (!confirm('Это необратимо. Точно стираем?')) return;
      void (async (): Promise<void> => {
        db.disabled = true; db.textContent = '… стираю';
        const r = await wipeAll();
        opts.onDone?.();
        alert(['Стёрто.', `рабочая копия: ${r.local.length} ключей`, `сервер: ${r.server.length} ключей`,
          ...(r.failed.length ? [`НЕ УДАЛОСЬ: ${r.failed.join(', ')}`] : []),
          '', 'Страница сейчас перезагрузится — редактор начнёт с чистого листа.'].join('\n'));
        location.reload();
      })();
    };
    danger.append(db);
    const dh = document.createElement('div');
    dh.style.cssText = 'color:#7a869e;font-size:10px;margin-top:3px';
    dh.textContent = 'после этого: загрузить модель → выбрать, чей это атлас → настраивать с нуля';
    danger.append(dh);
    box.append(danger);
    refresh();
  };

  async function doPublish(rerender: (s?: string) => void, o: typeof opts): Promise<void> {
    rerender('… публикую');
    const r = await publish();
    let msg = r.ok ? `✓ опубликовано: ${r.saved.map(keyLabel).join(', ') || '—'}` : '✗ ' + (r.error ?? 'не вышло');
    if (r.conflicts.length) msg += '\nрасходятся: ' + r.conflicts.map(keyLabel).join(', ') + ' — забери серверное или перезапиши осознанно';
    if (r.ok && o.publishExtra) {
      const e = await o.publishExtra();
      if (!e.ok) msg += '\n✗ конфиг: ' + (e.error ?? 'не вышло');
      else msg += '\n✓ конфиг моделей опубликован';
    }
    o.onDone?.();
    rerender(msg);
  }

  async function doPull(keys: string[], rerender: (s?: string) => void, o: typeof opts): Promise<void> {
    rerender('… забираю серверное');
    const got = await pullFromServer(keys);
    o.onDone?.();
    rerender(got.length ? `✓ забрано: ${got.map(keyLabel).join(', ')}. Перезагрузи страницу (F5), чтобы редактор перечитал.` : '✗ не удалось забрать');
  }

  render();
  document.body.append(back);
}
