import {
  type ConfigRegistry,
  type ClassDef,
} from '@dm/shared';

/** Список определений классов из конфига. Стартовый набор персонажа — shared `newCharacterSave`. */
export function listClasses(config: ConfigRegistry): ClassDef[] {
  return config.get('classes');
}

export function findClass(
  config: ConfigRegistry,
  classId: string,
): ClassDef | undefined {
  return config.get('classes').find((c) => c.id === classId);
}
