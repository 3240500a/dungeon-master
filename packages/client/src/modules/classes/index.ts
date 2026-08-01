import {
  type ConfigRegistry,
  type ClassDef,
} from '@dm/shared';

/** Список ВКЛЮЧЁННЫХ классов для выбора при создании (выключенные не предлагаются). Лукап по id — `findClass`. */
export function listClasses(config: ConfigRegistry): ClassDef[] {
  return config.get('classes').filter((c) => c.enabled !== false);
}

export function findClass(
  config: ConfigRegistry,
  classId: string,
): ClassDef | undefined {
  return config.get('classes').find((c) => c.id === classId);
}
