import { describe, it, expect } from 'vitest';
import { configSchemas } from '@dm/shared';
import { configKeyForFile, configFileNameFor } from './configFiles.js';

/**
 * Сервер следит за `data/*.json` и перечитывает их на лету — иначе правка файла не доезжает
 * ни до редактора, ни до клиентов, пока процесс не перезапустят. Всё это держится на одном
 * хрупком месте: восстановить КЛЮЧ по ИМЕНИ ФАЙЛА. Дефис в имени иногда точка в ключе
 * (`items-base` → `items.base`), а иногда так и остаётся дефисом (`skill-tree`).
 */
describe('файл данных ↔ ключ конфига', () => {
  it('туда и обратно для КАЖДОГО ключа реестра', () => {
    const keys = Object.keys(configSchemas);
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(configKeyForFile(configFileNameFor(k), keys), k).toBe(k);
    }
  });

  it('точка в ключе не путается с дефисом', () => {
    const keys = Object.keys(configSchemas);
    expect(configKeyForFile('items-base.json', keys)).toBe('items.base');
    expect(configKeyForFile('skill-tree.json', keys)).toBe('skill-tree');
    expect(configKeyForFile('skill-inserts.json', keys)).toBe('skill-inserts');
  });

  it('чужой файл ключом не притворяется', () => {
    const keys = Object.keys(configSchemas);
    expect(configKeyForFile('pose.json', keys)).toBeUndefined();
    expect(configKeyForFile('skill-tree.json.bak', keys)).toBeUndefined();
    expect(configKeyForFile('README.md', keys)).toBeUndefined();
  });
});
