/**
 * Крохотный мостик навигации редактора: `main.ts` регистрирует переключатель вкладок,
 * а другие вкладки (напр. «Симулятор») просят перейти на «Калькулятор» — без циклического импорта.
 */
export type EditorView = 'sim' | 'rungen' | 'itemgen' | 'monstergen' | 'calc' | 'config';

let navFn: ((view: EditorView) => void) | null = null;
export function setEditorNav(fn: (view: EditorView) => void): void { navFn = fn; }
export function navigateTo(view: EditorView): void { navFn?.(view); }
