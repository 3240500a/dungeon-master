import { ATTRIBUTES } from '../types/attributes.js';

/**
 * ⚠ R20-08: ОВЕРРАЙД ИЗ БАЗЫ, СОХРАНЁННЫЙ ПОД ПРЕЖНЕЙ СХЕМОЙ, — ПРИВЕСТИ, А НЕ ВЫБРОСИТЬ.
 *
 * Оверрайд редактора ложится таблицей целиком (`reload({[key]: value})`), и таблица, не прошедшая схему, пропускается вся. Когда схема
 * строже той, под которой оверрайд сохранён, одно старое значение выбрасывает ВСЕ правки хозяина в этой таблице. Так R18-07 (старт класса —
 * целые ≥ 0; до него редактор пускал дробь: «Ловкость + 0.5») делал с оверрайдом `classes`: одна дробь — и имена, галки, стартовое оружие
 * и старты прочих классов при каждой пересборке молча откатывались к файлу, а вход героя старше R18-07 (R19-01) писал ему старт со строки
 * файла.
 *
 * Здесь приводится только ОДНОЗНАЧНОЕ и только то, что новая схема сузила: старт класса — вниз до целого, не ниже нуля (дробную долю
 * очка не вложить никогда, минус — не атрибут). Прочее не трогается — не прошедшее схему пропускается, как прежде (инцидентом). Зовёт
 * только сборка живого конфига из базы (`server/configLive.ts`) и починка базы (`db:repair`): новая запись из редактора и файл данных
 * идут строгой схемой, мимо этого, — дробь там по-прежнему отказ.
 *
 * Возвращает приведённую копию (исходное не трогается) и список приведённого — вслух в лог; ничего не приведено — то же значение.
 */
export function upgradeStoredOverride(key: string, value: unknown): { value: unknown; fixes: string[] } {
  if (key !== 'classes' || !Array.isArray(value)) return { value, fixes: [] };
  const fixes: string[] = [];
  const rows = value.map((row: unknown, i) => {
    if (!row || typeof row !== 'object') return row;
    const st = (row as { startAttributes?: unknown }).startAttributes;
    if (!st || typeof st !== 'object') return row;
    let next: Record<string, unknown> | undefined;
    for (const a of ATTRIBUTES) {
      const v = (st as Record<string, unknown>)[a];
      if (typeof v !== 'number' || !Number.isFinite(v) || (Number.isInteger(v) && v >= 0)) continue;
      const n = Math.max(0, Math.floor(v));
      (next ??= { ...(st as Record<string, unknown>) })[a] = n;
      const id = (row as { id?: unknown }).id;
      fixes.push(`${typeof id === 'string' ? id : `#${i}`}.startAttributes.${a}: ${v} → ${n}`);
    }
    return next ? { ...(row as Record<string, unknown>), startAttributes: next } : row;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes };
}
