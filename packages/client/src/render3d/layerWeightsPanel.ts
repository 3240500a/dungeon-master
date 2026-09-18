/**
 * ПАНЕЛЬ ВЕСОВ СЛОЁВ — «какая анимация насколько влияет на какую часть тела».
 *
 * Просьба автора: «надо сделать в поз-редакторе на вкладке „Тест“, чтобы можно было настраивать, какие анимации
 * как влияют при беге и так далее». Панель правит `pe_layers` (см. `layerWeights.ts`): долю ЛОКОМОЦИИ над рукой,
 * кистью, грудью и головой — отдельно для ходьбы и бега, отдельно для релакса и боя.
 *
 * ⚠ ПАНЕЛЬ НИЧЕГО НЕ СЧИТАЕТ САМА. Значение ячейки — `layerCell` (тот же разбор наследования, что у рантайма), а
 * «сейчас NN %» — строки трассы `layerTrace`, которые пишет рантайм там же, где вес рождается. Вторая копия формулы
 * здесь разошлась бы с первой молча (тот же довод, что у инспектора «◫ слои»).
 *
 * ⚠ ПРАВИТСЯ ЖИВАЯ ЗАПИСЬ. Кукла вкладки «Тест» и манекен читают тот же объект на следующем кадре — пересобирать
 * ничего не надо, поэтому ползунок можно тянуть на бегу.
 *
 * ОДНА ФУНКЦИЯ НА ДВЕ ВКЛАДКИ («Тест» и «Бег»): ручка живёт там, где ею пользуются, но двум копиям UI разъехаться
 * негде. Прежний одиночный ползунок «доля гейта над руками» заменён этой панелью.
 */
import { layerTrace } from './poseRuntime.js';
import { watchLayerTrace } from './layerTraceView.js';
import { LAYER_PARTS, LAYER_FIXED, LAYER_LEGACY_DEFAULT, lookupLayers, layerEditKey, layerCell, setLayerCell, clearLayerCell, ensureLayerEntry, ownLayerEntry,
  type LayerPart, type LayerSpeed, type LayerStore, type SwayStore } from './layerWeights.js';

export interface LayerPanelHost {
  charId(): string;
  weapon(): string;
  /** ЖИВОЙ стор `pe_layers` — тот же объект, что читает `resolveUpper` редактора. */
  layers(): LayerStore;
  /** Легаси `pe_sway` (только чтение): умолчание частей без своей записи. */
  sway(): SwayStore;
  save(): void;
  /** Показывать ли живые «сейчас NN %» (нужна шагающая кукла — вкладки «Тест» и «Бег» с превью). */
  live?: boolean;
}
export interface LayerPanel {
  el: HTMLElement;
  /** Кадр: обновить живые проценты. Дёшево — только текст и ширина полосок. */
  update(): void;
  dispose(): void;
}

const css = {
  box: 'margin-top:8px;padding:6px 7px;background:#161a26;border:1px solid #39415a;border-radius:5px;font:11px/1.35 monospace;color:#cfd3e0',
  head: 'color:#8fb7ff;font-weight:bold;margin-bottom:2px',
  note: 'color:#7a869e;font-size:10px;margin:2px 0 4px',
  warn: 'color:#e0a05a;font-size:10px;margin:2px 0 4px',
  btn: 'margin:2px 3px 2px 0;padding:2px 6px;background:#2a3350;color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:10px monospace',
  btnOn: 'margin:2px 3px 2px 0;padding:2px 6px;background:#3a5030;color:#dff0d8;border:1px solid #587a5e;border-radius:4px;cursor:pointer;font:10px monospace',
  part: 'display:flex;align-items:center;gap:5px;margin-top:5px',
  partName: 'flex:0 0 58px;color:#cfd3e0',
  bar: 'flex:1 1 auto;height:6px;background:#1b2030;border-radius:3px;overflow:hidden',
  now: 'flex:0 0 64px;text-align:right;font-size:10px;color:#9aa3b8',
  cell: 'display:flex;align-items:center;gap:4px;margin:1px 0 0 12px',
  cellName: 'flex:0 0 46px;font-size:10px;color:#9aa3b8',
  val: 'flex:0 0 30px;text-align:right;font-size:10px',
  rst: 'flex:0 0 14px;cursor:pointer;color:#6b7180;font-size:11px;text-align:center;user-select:none',
  fixed: 'display:flex;gap:6px;margin-top:3px;font-size:10px;color:#565d70',
};
const mk = (tag: string, style: string, text?: string): HTMLElement => {
  const e = document.createElement(tag); e.style.cssText = style; if (text !== undefined) e.textContent = text; return e;
};
const tint = (w: number): string => (w > 0.66 ? '#46d07a' : w > 0.05 ? '#ffd24a' : '#4a5680');
const SPEEDS: readonly { id: LayerSpeed; label: string }[] = [{ id: 'walk', label: 'ходьба' }, { id: 'run', label: 'бег' }];

export function createLayerWeightsPanel(host: LayerPanelHost): LayerPanel {
  const root = mk('div', css.box);
  let combat = false;
  const unwatch = host.live ? watchLayerTrace() : null;
  /** Живые индикаторы по частям — обновляются из трассы, без перерисовки панели. */
  const nowOf = new Map<LayerPart, { fill: HTMLElement; txt: HTMLElement }>();
  let axes: HTMLElement | null = null;

  /** Под каким ключом правим: своя запись точного ключа, если она есть, иначе ОБЩАЯ базового оружия (`layerEditKey`). */
  const editKey = (): { key: string; own: boolean; base: string } => layerEditKey(host.layers(), host.charId(), host.weapon());

  const render = (): void => {
    root.replaceChildren(); nowOf.clear();
    const charId = host.charId(), weapon = host.weapon();
    const lk = lookupLayers(host.layers(), host.sway(), charId, weapon);
    const ek = editKey();
    root.append(mk('div', css.head, 'ВЕСА СЛОЁВ — сколько части тела берёт ход'));
    root.append(mk('div', css.note, '0 — частью целиком владеет авторская стойка, 1 — целиком ходьба/бег (клип или мах походки). '
      + 'Стоя стойка владеет всем при любых весах: вес — доля ЛОКОМОЦИИ, а стоя её нет.'));

    // ── Чья настройка действует и под каким ключом правим ──
    const who = mk('div', lk.source === 'default' ? css.warn : css.note);
    who.textContent = lk.source === 'layers' ? `действует: веса «${lk.weapon}»${lk.weapon !== weapon ? ` — своих у «${weapon}» нет` : ''}`
      : lk.source === 'sway' ? `действует: одно число на весь верх — ${lk.swing.toFixed(2)} («${lk.weapon}», старый «остаточный мах»)`
        : `своих весов нет — действует умолчание ${LAYER_LEGACY_DEFAULT} на весь верх (клипу достаётся пятая часть рук)`;
    root.append(who);
    const keyRow = mk('div', 'margin-bottom:2px');
    if (ek.own) {
      keyRow.append(mk('span', 'font-size:10px;color:#9ae6a0', `правится СВОЯ запись «${weapon}» `));
      const b = mk('button', css.btn, `✕ снять свою (вернётся «${ek.base}»)`);
      b.onclick = () => { delete host.layers()[charId]![weapon]; host.save(); render(); };
      keyRow.append(b);
    } else {
      keyRow.append(mk('span', 'font-size:10px;color:#9aa3b8', ek.base !== weapon
        ? `правится ОБЩАЯ запись «${ek.base}» (действует и на «${weapon}») ` : `правится запись «${ek.base}» `));
      if (ek.base !== weapon) {
        const b = mk('button', css.btn, `отделить свою для «${weapon}»`);
        b.title = 'Завести отдельные веса под этот набор рук — копией того, что действует сейчас.';
        b.onclick = () => { ensureLayerEntry(host.layers(), host.sway(), charId, weapon); host.save(); render(); };
        keyRow.append(b);
      }
    }
    root.append(keyRow);

    // ── Релакс / бой ──
    const modeRow = mk('div', '');
    for (const [c, label] of [[false, 'релакс'], [true, 'бой']] as const) {
      const b = mk('button', combat === c ? css.btnOn : css.btn, label);
      b.onclick = () => { combat = c; render(); };
      modeRow.append(b);
    }
    modeRow.append(mk('span', 'font-size:10px;color:#6b7180', combat ? ' ячейка без своей записи — как в релаксе' : ''));
    root.append(modeRow);
    if (host.live) { axes = mk('div', 'font-size:10px;color:#9aa3b8;margin-top:2px'); root.append(axes); }

    // ── Части ──
    const entryNow = (): ReturnType<typeof lookupLayers> => lookupLayers(host.layers(), host.sway(), charId, ek.key);
    for (const p of LAYER_PARTS) {
      const line = mk('div', css.part);
      line.append(mk('span', css.partName, p.label));
      if (host.live) {
        const bar = mk('div', css.bar), fill = mk('div', 'height:100%;width:0%');
        bar.append(fill);
        const txt = mk('span', css.now, '—');
        line.append(bar, txt);
        nowOf.set(p.id, { fill, txt });
      }
      root.append(line);
      for (const sp of SPEEDS) {
        const cur = entryNow();
        // Умолчание головы зависит от режима (смешанный 1 / «только клипы» 0) — показываем то, что у игры: клипы.
        const c = layerCell(cur.entry, p.id, sp.id, combat, cur.swing, 0);
        const row = mk('div', css.cell);
        row.append(mk('span', css.cellName, sp.label));
        const sl = document.createElement('input');
        sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05'; sl.value = String(c.value); sl.style.flex = '1';
        const val = mk('span', css.val, c.value.toFixed(2));
        val.style.color = c.own ? '#9ae6a0' : '#6b7180';
        val.title = c.own ? 'своя запись' : 'своей записи нет — значение наследуется';
        const rst = mk('span', css.rst, c.own ? '↺' : '');
        rst.title = 'снять запись ячейки — вернётся уровень ниже (бой → релакс → умолчание)';
        sl.oninput = () => {
          const v = parseFloat(sl.value);
          setLayerCell(ownLayerEntry(host.layers(), charId, ek.key), p.id, sp.id, combat, v);
          val.textContent = v.toFixed(2); val.style.color = '#9ae6a0'; rst.textContent = '↺';
          host.save();
        };
        // Структура панели (подпись «действует…», наследование боя) меняется только ПОСЛЕ отпускания: перерисовка на
        // каждом `input` отбирала бы ползунок из-под мыши.
        sl.onchange = () => render();
        rst.onclick = () => {
          const e = host.layers()[charId]?.[ek.key];
          if (!e) return;
          clearLayerCell(e, p.id, sp.id, combat); host.save(); render();
        };
        row.append(sl, val, rst);
        root.append(row);
      }
    }
    for (const f of LAYER_FIXED) {
      const r = mk('div', css.fixed);
      r.append(mk('span', 'flex:1', f.label), mk('span', '', f.owner));
      root.append(r);
    }
    if (host.layers()[charId]?.[ek.key]) {
      const b = mk('button', css.btn, `↺ снести веса «${ek.key}» целиком`);
      b.style.marginTop = '5px';
      b.onclick = () => { if (!confirm(`Снести все веса слоёв «${ek.key}»? Вернётся умолчание.`)) return; delete host.layers()[charId]![ek.key]; host.save(); render(); };
      root.append(b);
    }
  };
  render();

  return {
    el: root,
    update(): void {
      if (!host.live) return;
      const stale = Date.now() - layerTrace.t > 500;
      if (axes) {
        axes.textContent = stale ? 'кукла не шагает — живых долей нет'
          : `сейчас: ${layerTrace.speed.toFixed(0)} ед/с · бег ${Math.round(layerTrace.sb * 100)} %` + (layerTrace.combat > 0.005 ? ` · бой ${Math.round(layerTrace.combat * 100)} %` : '');
      }
      for (const p of LAYER_PARTS) {
        const n = nowOf.get(p.id); if (!n) continue;
        const r = stale ? undefined : layerTrace.rows.find((x) => x.layer === '↳ ' + p.label);
        if (!r) { n.fill.style.width = '0%'; n.txt.textContent = '—'; continue; }
        n.fill.style.width = `${Math.round(r.w * 100)}%`; n.fill.style.background = tint(r.w);
        n.txt.textContent = `ход ${Math.round(r.w * 100)} %`; n.txt.style.color = tint(r.w);
        n.txt.title = r.note ?? '';
      }
    },
    dispose(): void { unwatch?.(); root.remove(); },
  };
}
