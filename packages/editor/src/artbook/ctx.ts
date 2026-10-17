/**
 * ⭐ 16.10 (Артбук): КОНТЕКСТ страниц вкладки — то, что получает каждая подвкладка (`renderLocations`, `renderMonsters`,
 * `renderCharacters`). Через него страница читает конфиг и сид, пишет правки и рисует общие виджеты, не зная, как они хранятся.
 */
import type { ConfigRegistry } from '@dm/shared';
import type { ArtbookDoc, SlotDef } from './model.js';
import type { ArtbookSeed, RosterIndex, RosterV2 } from './seed.js';

export type ArtTab = 'locations' | 'monsters' | 'characters' | 'models';

export interface TextOpts {
  /** Тег обёртки (по умолчанию `div`; в строке таблицы — `span`). */
  tag?: 'div' | 'span' | 'p';
  css?: string;
  /** Однострочное поле (input вместо textarea). */
  single?: boolean;
  /** Что показать вместо пустого поля в режиме правки. */
  placeholder?: string;
  /** Без бейджей пометок движка (`[есть]`, `[код К5]`…). */
  plain?: boolean;
  /** Не править по клику (текст внутри кликабельной карточки). */
  readonly?: boolean;
  /** ⭐ 17.10: жирное начало — текст начинается с него (пункт сводки решений: заголовок пункта и пункт целиком). */
  lead?: string;
}

export interface ListOpts extends TextOpts {
  /** Нумерованный список (по умолчанию — маркеры). */
  ordered?: boolean;
  /** Абзацами, а не списком. */
  paragraphs?: boolean;
}

export interface SlotOpts {
  /** `grid` — плитка картинок (по умолчанию); `hero` — главная крупно + полоса вариантов; `compact` — одна строка миниатюр. */
  layout?: 'grid' | 'hero' | 'compact';
  /** Подпись под заголовком слота. */
  hint?: string;
}

export interface ThumbOpts {
  w?: number;
  h?: number;
  /** Текст пунктирной заглушки (по умолчанию «нет концепта»). */
  empty?: string;
  /** Клик по миниатюре открывает лайтбокс (по умолчанию нет: миниатюра обычно внутри кликабельной карточки). */
  zoom?: boolean;
}

export interface ArtbookCtx {
  /** Снимок конфига редактора (тот же, что `/api/config` после загрузки; до неё — встроенные дефолты). */
  data: Record<string, unknown>;
  /** Реестр из `data` (кэш на отрисовку). Конфиг не разобрался — бросает; текст ошибки — `regError()`. */
  reg(): ConfigRegistry;
  /** Ошибка разбора конфига или `undefined`. */
  regError(): string | undefined;
  /** Сид как в репозитории (без правок). ⭐ 17.10: с ЗАГРУЖЕННЫМИ ростерами v2 под `v2` (пути правки `v2/<подтип>/…`, `v2/index/…`). */
  seed: ArtbookSeed;
  /** Сид с правками владельца — то, что видно на странице (пересчитывается после каждой правки). */
  view: ArtbookSeed;
  /** Документ `pe_artbook` (картинки, правки). Мутировать функциями `model.ts`, затем `commit()`. */
  doc(): ArtbookDoc;
  /** Документ изменён: сохранить (локально сразу, сервер — с задержкой) и перерисовать страницу. */
  commit(): void;
  /** Документ изменён, но страницу НЕ перерисовывать (правка текста обновляет только своё поле — открытые рядом правки живут). */
  touch(): void;
  /** Перерисовать текущую страницу (без записи). */
  rerender(): void;
  /** Маршрут внутри подвкладки (помнится): у «Локаций» `''` / `biome:<id>`, у «Монстров» — свой (`sub:<id>`, `arch:<a>:<s>`, `matrix`…). */
  route: string;
  /** Перейти по маршруту своей подвкладки (прокрутка — в начало; «назад» — `go('')`). */
  go(route: string): void;
  /** Перейти на другую подвкладку (и маршрут в ней). */
  open(tab: ArtTab, route?: string): void;
  /** Править текст на месте разрешено (переключатель «✎ правка по клику» в шапке). */
  canEdit: boolean;
  /** Правимый текст по пути поля (`crypt/subtypes/greece/lore`). */
  text(path: string, opts?: TextOpts): HTMLElement;
  /** Правимый список строк по пути массива (каждый пункт правится отдельно). */
  list(path: string, opts?: ListOpts): HTMLElement;
  /** Слот картинок: загрузка (перетаскиванием или кнопкой), подпись, статус, ★, убрать, лайтбокс. `def` — описание слота или заголовок. */
  slot(key: string, def: SlotDef | string, opts?: SlotOpts): HTMLElement;
  /** Набор слотов карточки: ключ каждого — `slotKey(...prefix, def.id)`. */
  slots(prefix: string[], defs: readonly SlotDef[], opts?: SlotOpts): HTMLElement;
  /** Миниатюра слота: утверждённая главная, иначе пунктир (с числом черновиков). */
  thumb(key: string, opts?: ThumbOpts): HTMLElement;
  /** Открыть конфиг в секции «Игра» (`biomes`, `monsters`, `classes`…). */
  gotoConfig(key: string): void;
  /**
   * ⭐ 17.10: ростер подтипа по ярусам (`seed/v2/<подтип>.json`) — ЛЕНИВО: первый вызов начинает загрузку и отдаёт `null`, по
   * загрузке страница перерисуется сама. Тексты ростера правятся по пути `v2/<подтип>/…` (`ctx.text`), как и тексты черновика.
   */
  roster(subId: string): RosterV2 | null;
  /** Сводка ростеров и общие таблицы (`seed/v2/index.json`), лениво; пути правки — `v2/index/…`. */
  rosterIndex(): RosterIndex | null;
  /** Ошибка загрузки (`<подтип>` или `index`) или `undefined`. */
  rosterError(key: string): string | undefined;
  /** Забыть ошибку загрузки и попробовать снова (перерисовка — сама). */
  rosterRetry(key: string): void;
}
