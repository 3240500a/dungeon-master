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
  onLowRes?: (on: boolean) => void;
}

const LS_KEY = 'dm3d_settings';   // сохранённые галки настроек 3D

/** Возвращает `applySaved` — online3d зовёт ПОСЛЕ инициализации своих let'ов (self/playerLight), иначе синхронный
 *  вызов колбэков из mountSettings ловит TDZ (Cannot access 'playerLight' before initialization). */
export function mountSettings(root: HTMLElement, opts: SettingsOpts): () => void {
  const ROWS: { key: string; label: string; cb?: (on: boolean) => void }[] = [
    { key: 'monKin', label: 'Кинематика монстров (физика: удар/смерть)', cb: opts.onMonKinematic },
    { key: 'monNoIk', label: 'Монстры без вспом. IK (стопы/вторая рука)', cb: opts.onMonNoIk },
    { key: 'plKin', label: 'Игрок кинематик (физика: удар/смерть)', cb: opts.onPlayerKinematic },
    { key: 'plNoIk', label: 'Игрок без вспом. IK', cb: opts.onPlayerNoIk },
    { key: 'dmgOff', label: 'Без всплывающих чисел урона', cb: opts.onDmgNumbers },
    { key: 'fxOff', label: 'Без партикл-эффектов статусов', cb: opts.onStatusFx },
    { key: 'torchSh', label: 'Тени от факелов (тяжело)', cb: opts.onTorchShadows },
    { key: 'heroSh', label: 'Тень от света героя', cb: opts.onPlayerShadow },
    { key: 'lowRes', label: 'Низкое разрешение 1× (perf)', cb: opts.onLowRes },
  ];

  let saved: Record<string, boolean> = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Record<string, boolean>; } catch { saved = {}; }
  const state: Record<string, boolean> = {};
  const save = (): void => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* приватный режим */ } };

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:52px;z-index:70;display:none;background:rgba(8,10,16,0.92);' +
    'border:1px solid #35506a;border-radius:6px;padding:10px 12px;font:12px/1.6 system-ui,sans-serif;color:#cfe0d6;pointer-events:auto;min-width:250px';
  const title = document.createElement('div'); title.textContent = 'Настройки — графика / производительность';
  title.style.cssText = 'color:#9fe0c0;margin-bottom:8px;font-weight:600;font-size:12px';
  panel.appendChild(title);
  for (const r of ROWS) {
    const on = !!saved[r.key]; state[r.key] = on;
    const row = document.createElement('label'); row.style.cssText = 'display:block;cursor:pointer;padding:2px 0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = on; cb.style.cssText = 'margin-right:8px;vertical-align:middle';
    cb.addEventListener('change', () => { state[r.key] = cb.checked; save(); r.cb?.(cb.checked); });
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

  // НЕ применяем синхронно (TDZ на self/playerLight) — возвращаем функцию, online3d зовёт после своих let'ов.
  return () => { for (const r of ROWS) if (state[r.key]) r.cb?.(true); };
}
