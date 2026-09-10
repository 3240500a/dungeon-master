/**
 * Сопоставление «файл данных ↔ ключ конфига». Вынесено отдельно, потому что правило неочевидное
 * и легко ломается: в имени файла дефис, а в ключе может быть ТОЧКА (`items-base.json` →
 * `items.base`), но не всегда (`skill-tree.json` → `skill-tree`, дефис остаётся дефисом).
 * Наивная замена всех дефисов на точки промахивается по большинству ключей.
 *
 * Поэтому идём от списка ИЗВЕСТНЫХ ключей, а не от догадок по имени: имя файла собирается из
 * ключа однозначно, обратное сопоставление — простым перебором.
 */
export function configKeyForFile(file: string, known: readonly string[]): string | undefined {
  if (!file.endsWith('.json')) return undefined;
  return known.find((k) => k.replace(/\./g, '-') + '.json' === file);
}

/** Имя файла данных для ключа конфига (обратная сторона того же правила). */
export function configFileNameFor(key: string): string {
  return key.replace(/\./g, '-') + '.json';
}
