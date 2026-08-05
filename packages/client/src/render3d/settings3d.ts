/**
 * Панель настроек 3D-клиента (кнопка-шестерёнка ⚙): графика/производительность.
 * Чекбоксы применяет `online3d` через колбэки. Состояние ПЕРСИСТИТСЯ в localStorage (по стабильному ключу строки)
 * и применяется при монтировании (вызываем колбэки для включённых). Параметры теней — в конфиг-редакторе (balance.lighting.shadow3d).
 */
export interface SettingsOpts {
  onMonKinematic?: (on: boolean) => void;
  onMonNoIk?: (on: boolean) => void;
  onPlayerKinematic?: (on: boolean) => void;
  onPlayerNoIk?: (on: boolean) => void;
  onDmgNumbers?: (on: boolean) => void;
  onStatusFx?: (on: boolean) => void;
  onTorchShadows?: (on: boolean) => void;
  onPlayerShadow?: (on: boolean) => void;
  onAdaptiveRes?: (on: boolean) => void;   // авто-разрешение по FPS вкл/выкл
  onResScale?: (v: number) => void;        // ручное разрешение (pixelRatio) 0.5–2×
}

const LS_KEY = 'dm3d_settings';   // сохранённые галки настроек 3D

/** Возвращает `applySaved` — online3d зовёт ПОСЛЕ инициализации своих let'ов (self/playerLight), иначе синхронный
 *  вызов колбэков из mountSettings ловит TDZ (Cannot access 'playerLight' before initialization). */
export function mountSettings(root: HTMLElement, opts: SettingsOpts): () => void {
  const ROWS: { key: string; label: string; cb?: (on: boolean) => void; def?: boolean }[] = [
    { key: 'monKin', label: 'Кинематика монстров (физика: удар/смерть)', cb: opts.onMonKinematic },
    { key: 'monNoIk', label: 'Монстры без вспом. IK (стопы/вторая рука)', cb: opts.onMonNoIk },
    { key: 'plKin', label: 'Игрок кинематик (физика: удар/смерть)', cb: opts.onPlayerKinematic },
    { key: 'plNoIk', label: 'Игрок без вспом. IK', cb: opts.onPlayerNoIk },
    { key: 'dmgOff', label: 'Без всплывающих чисел урона', cb: opts.onDmgNumbers },
    { key: 'fxOff', label: 'Без партикл-эффектов статусов', cb: opts.onStatusFx },
    { key: 'torchSh', label: 'Тени от факелов (тяжело)', cb: opts.onTorchShadows },
    { key: 'heroSh', label: 'Тень от света героя', cb: opts.onPlayerShadow },
  ];

  let saved: Record<string, boolean | number> = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, boolean | number>; } catch { saved = {}; }
  const state: Record<string, boolean | number> = {};
  const save = (): void => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* приватный режим */ } };

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:52px;z-index:70;display:none;background:rgba(8,10,16,0.92);' +
    'border:1px solid #35506a;border-radius:6px;padding:10px 12px;font:12px/1.6 system-ui,sans-serif;color:#cfe0d6;pointer-events:auto;min-width:250px';
  const title = document.createElement('div'); title.textContent = 'Настройки — графика / производительность';
  title.style.cssText = 'color:#9fe0c0;margin-bottom:8px;font-weight:600;font-size:12px';
  panel.appendChild(title);
  for (const r of ROWS) {
    const on = r.key in saved ? !!saved[r.key] : !!r.def; state[r.key] = on;   // не сохранён → дефолт строки (адаптив вкл по умолчанию)
    const row = document.createElement('label'); row.style.cssText = 'display:block;cursor:pointer;padding:2px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = on; cb.style.cssText = 'margin-right:8px;vertical-align:middle';
    cb.addEventListener('change', () => { state[r.key] = cb.checked; save(); r.cb?.(cb.checked); });
    row.append(cb, document.createTextNode(r.label)); panel.appendChild(row);
  }

  // ── Разрешение: авто (по FPS) ИЛИ ручной ползунок 0.5–2× (>1 = суперсэмплинг) ──
  const resAuto0 = 'resAuto' in saved ? !!saved['resAuto'] : true;
  const resScale0 = typeof saved['resScale'] === 'number' ? saved['resScale'] : 1;
  state['resAuto'] = resAuto0; state['resScale'] = resScale0;
  const resBlock = document.createElement('div');
  resBlock.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #2a3340';
  const autoRow = document.createElement('label'); autoRow.style.cssText = 'display:block;cursor:pointer;padding:2px 0';
  const autoCb = document.createElement('input'); autoCb.type = 'checkbox'; autoCb.checked = resAuto0; autoCb.style.cssText = 'margin-right:8px;vertical-align:middle';
  autoRow.append(autoCb, document.createTextNode('Разрешение: авто (по FPS)'));
  const sRow = document.createElement('div'); sRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0';
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0.5'; slider.max = '2'; slider.step = '0.25'; slider.value = String(resScale0); slider.style.cssText = 'flex:1';
  const sVal = document.createElement('span'); sVal.textContent = `${resScale0.toFixed(2)}×`; sVal.style.cssText = 'min-width:40px;text-align:right;color:#caa64b';
  sRow.append(document.createTextNode('ручное'), slider, sVal);
  resBlock.append(autoRow, sRow); panel.appendChild(resBlock);
  const syncSlider = (): void => { slider.disabled = autoCb.checked; sRow.style.opacity = autoCb.checked ? '0.45' : '1'; };
  syncSlider();
  autoCb.addEventListener('change', () => {
    state['resAuto'] = autoCb.checked; save(); syncSlider();
    opts.onAdaptiveRes?.(autoCb.checked);
    if (!autoCb.checked) opts.onResScale?.(Number(slider.value));   // переход в ручной → применить текущее значение
  });
  slider.addEventListener('input', () => {
    const v = Number(slider.value); sVal.textContent = `${v.toFixed(2)}×`;
    state['resScale'] = v; save(); opts.onResScale?.(v);
  });

  root.appendChild(panel);

  const btn = document.createElement('button'); btn.textContent = '⚙'; btn.title = 'Настройки';
  btn.style.cssText = 'position:fixed;right:52px;bottom:12px;z-index:70;width:32px;height:28px;background:#1c2130;color:#cfe0d6;' +
    'border:1px solid #39415a;border-radius:5px;cursor:pointer;font:16px monospace;pointer-events:auto;line-height:1';
  root.appendChild(btn);

  let open = false;
  const setOpen = (v: boolean): void => { open = v; panel.style.display = open ? 'block' : 'none'; btn.style.background = open ? '#274032' : '#1c2130'; };
  btn.addEventListener('click', () => setOpen(!open));

  // НЕ применяем синхронно (TDZ на self/playerLight) — возвращаем функцию, online3d зовёт после своих let'ов.
  return () => {
    for (const r of ROWS) if (state[r.key]) r.cb?.(true);
    opts.onResScale?.(resScale0);        // сначала ручное значение (manualPR)
    opts.onAdaptiveRes?.(resAuto0);      // затем режим: авто (контроллер) или ручной (применит manualPR)
  };
}
