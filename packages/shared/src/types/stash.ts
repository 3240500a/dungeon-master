import type { Item } from './items.js';

/**
 * Общий на аккаунт городской сундук (shared stash, в духе D2R). Живёт ВНЕ `SaveState`
 * — на уровне аккаунта (одна истина на всех персонажей пользователя), чтобы можно было
 * перекладывать шмот между своими героями. Каждая вкладка — независимая сетка предметов
 * (`pos` в координатах этой вкладки; размер вкладки задаёт `balance.stash`).
 */
export interface AccountStash {
  version: number;
  tabs: Item[][];
}

export const STASH_VERSION = 1;
