/**
 * ИСТОРИЯ ПРАВОК — линейный командный стек (Ф1.3).
 *
 * До этого откат в поз-редакторе хранил ТОЛЬКО позу манекена + состояние эффекторов, поэтому
 * добавление/удаление/перенос кадра, удаление клипа, импорт и запекание были неоткатны вовсе.
 * Здесь стек хранит пары функций (undo/redo) — значит одна и та же история покрывает и правку позы,
 * и структурные операции над клипом/библиотекой, и Ctrl+Z идёт по ним в едином порядке.
 *
 * Файл ЧИСТЫЙ (без THREE и DOM) — тестируется в node.
 */

export interface Command { label: string; undo: () => void; redo: () => void }

export interface History {
  /** Записать уже СОВЕРШЁННУЮ операцию: `undo` возвращает «как было», `redo` — «как стало». */
  push(label: string, undo: () => void, redo: () => void): void;
  /** Выполнить `act()` и записать её в историю, сняв состояние до и после через `take`/`put`. */
  run<T>(label: string, take: () => T, put: (s: T) => void, act: () => void): void;
  undo(): string | null;                 // метка отменённой операции (или null)
  redo(): string | null;                 // метка повторённой операции (или null)
  clear(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Метки верхушек стеков — для подписи на кнопках/тултипов. */
  peek(): { undo: string | null; redo: string | null };
  size(): { undo: number; redo: number };
}

/** `cap` — сколько шагов держим (старые вытесняются снизу). */
export function makeHistory(cap = 100): History {
  let undoStack: Command[] = [];
  let redoStack: Command[] = [];
  let busy = false;                      // защита от рекурсии: undo/redo сами не должны писаться в историю

  const push = (label: string, undo: () => void, redo: () => void): void => {
    if (busy) return;
    undoStack.push({ label, undo, redo });
    if (undoStack.length > cap) undoStack.shift();
    redoStack = [];                      // новая ветка правок обрывает redo
  };

  return {
    push,
    run(label, take, put, act) {
      const before = take();
      act();
      const after = take();
      push(label, () => put(before), () => put(after));
    },
    undo() {
      const c = undoStack.pop(); if (!c) return null;
      busy = true; try { c.undo(); } finally { busy = false; }
      redoStack.push(c);
      return c.label;
    },
    redo() {
      const c = redoStack.pop(); if (!c) return null;
      busy = true; try { c.redo(); } finally { busy = false; }
      undoStack.push(c);
      return c.label;
    },
    clear() { undoStack = []; redoStack = []; },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    peek: () => ({ undo: undoStack.length ? undoStack[undoStack.length - 1]!.label : null, redo: redoStack.length ? redoStack[redoStack.length - 1]!.label : null }),
    size: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}
