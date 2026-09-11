/**
 * Общие DOM-хелперы граф-редакторов (пассивное древо мастерства + древо скилов):
 * поля-инпуты, заголовки, кнопки и всплывающее контекстное меню. Вынесены сюда, чтобы
 * не дублировать между `passiveGraph.ts` и `skillGraph.ts`.
 */

export const inputCss =
  'width:100%;box-sizing:border-box;padding:5px 6px;background:#1c1c26;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px';

export function hdr(text: string): HTMLElement {
  const h = document.createElement('div');
  h.textContent = text;
  h.style.cssText = 'font-weight:600;color:#e8e8f0;font-size:13px;margin:12px 0 6px;border-bottom:1px solid #2c2c3a;padding-bottom:3px';
  return h;
}
export function field(label: string, input: HTMLElement): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:block;font-size:11px;color:#9aa0b0;margin:6px 0';
  const l = document.createElement('div'); l.textContent = label; l.style.marginBottom = '3px';
  box.append(l, input);
  return box;
}
export function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'text'; el.value = value; el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}
export function numInput(value: number, step: number, onInput: (v: number) => void): HTMLInputElement {
  const el = document.createElement('input'); el.type = 'number'; el.step = String(step); el.value = String(value); el.style.cssText = inputCss;
  el.addEventListener('input', () => onInput(parseFloat(el.value) || 0));
  return el;
}
export function selectInput(opts: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = document.createElement('select'); el.style.cssText = inputCss;
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; if (v === value) o.selected = true; el.appendChild(o); }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
export function checkRow(label: string, checked: boolean, onToggle: () => void): HTMLElement {
  const box = document.createElement('label');
  box.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#c9cdd8;margin:8px 0;cursor:pointer';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
  cb.addEventListener('change', onToggle);
  box.append(cb, txt(label));
  return box;
}
export function txt(s: string, color = '#c9cdd8'): HTMLElement {
  const el = document.createElement('span'); el.textContent = s; el.style.color = color; el.style.fontSize = '12px';
  return el;
}
export function smallBtn(text: string, onClick: () => void, bg = '#2c2c3a'): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = text;
  b.style.cssText = `padding:4px 8px;cursor:pointer;background:${bg};color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px`;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

// ── Контекстное меню (одно на всё приложение) ────────────────────────────────────
let menuEl: HTMLElement | null = null;
export function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }
export function showMenu(clientX: number, clientY: number, items: { label: string; fn: () => void }[]): void {
  closeMenu();
  const m = document.createElement('div');
  m.style.cssText = `position:fixed;left:${clientX}px;top:${clientY}px;z-index:1000;background:#1c1c26;border:1px solid #3c3c4a;border-radius:6px;padding:4px;box-shadow:0 6px 18px rgba(0,0,0,.5);min-width:170px`;
  for (const it of items) {
    const b = document.createElement('div');
    b.textContent = it.label;
    b.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:13px;color:#e8e8f0;border-radius:4px';
    b.addEventListener('mouseenter', () => { b.style.background = '#33334a'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { closeMenu(); it.fn(); });
    m.appendChild(b);
  }
  menuEl = m;
  document.body.appendChild(m);
  setTimeout(() => {
    const off = (e: MouseEvent): void => { if (menuEl && !menuEl.contains(e.target as Node)) { closeMenu(); window.removeEventListener('pointerdown', off, true); } };
    window.addEventListener('pointerdown', off, true);
  }, 0);
}
