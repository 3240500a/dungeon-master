/**
 * Панель настроек 3D-клиента (кнопка-шестерёнка ⚙): графика/производительность.
 * Чекбоксы применяет `online3d` через колбэки (те же тумблеры, что раньше жили в DBG-панели, — вынесены сюда,
 * чтобы игрок мог крутить перф-опции без debug-режима). Состояние — только в чекбоксах (не персистится).
 */
export interface SettingsOpts {
  onMonKinematic?: (on: boolean) => void;
  onMonNoIk?: (on: boolean) => void;
  onPlayerKinematic?: (on: boolean) => void;
  onPlayerNoIk?: (on: boolean) => void;
  onDmgNumbers?: (on: boolean) => void;
  onStatusFx?: (on: boolean) => void;
  onTorchShadows?: (on: boolean) => void;
  onLowRes?: (on: boolean) => void;
}

export function mountSettings(root: HTMLElement, opts: SettingsOpts): void {
  const ROWS: { label: string; cb?: (on: boolean) => void }[] = [
    { label: 'Кинематика монстров (физика: удар/смерть)', cb: opts.onMonKinematic },
    { label: 'Монстры без вспом. IK (стопы/вторая рука)', cb: opts.onMonNoIk },
    { label: 'Игрок кинематик (физика: удар/смерть)', cb: opts.onPlayerKinematic },
    { label: 'Игрок без вспом. IK', cb: opts.onPlayerNoIk },
    { label: 'Без всплывающих чисел урона', cb: opts.onDmgNumbers },
    { label: 'Без партикл-эффектов статусов', cb: opts.onStatusFx },
    { label: 'Тени от факелов (тяжело)', cb: opts.onTorchShadows },
    { label: 'Низкое разрешение 1× (perf)', cb: opts.onLowRes },
  ];

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:52px;z-index:70;display:none;background:rgba(8,10,16,0.92);' +
    'border:1px solid #35506a;border-radius:6px;padding:10px 12px;font:12px/1.6 system-ui,sans-serif;color:#cfe0d6;pointer-events:auto;min-width:250px';
  const title = document.createElement('div'); title.textContent = 'Настройки — графика / производительность';
  title.style.cssText = 'color:#9fe0c0;margin-bottom:8px;font-weight:600;font-size:12px';
  panel.appendChild(title);
  for (const r of ROWS) {
    const row = document.createElement('label'); row.style.cssText = 'display:block;cursor:pointer;padding:2px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.cssText = 'margin-right:8px;vertical-align:middle';
    cb.addEventListener('change', () => r.cb?.(cb.checked));
    row.append(cb, document.createTextNode(r.label)); panel.appendChild(row);
  }
  root.appendChild(panel);

  const btn = document.createElement('button'); btn.textContent = '⚙'; btn.title = 'Настройки';
  btn.style.cssText = 'position:fixed;right:52px;bottom:12px;z-index:70;width:32px;height:28px;background:#1c2130;color:#cfe0d6;' +
    'border:1px solid #39415a;border-radius:5px;cursor:pointer;font:16px monospace;pointer-events:auto;line-height:1';
  root.appendChild(btn);

  let open = false;
  const setOpen = (v: boolean): void => { open = v; panel.style.display = open ? 'block' : 'none'; btn.style.background = open ? '#274032' : '#1c2130'; };
  btn.addEventListener('click', () => setOpen(!open));
}
