import { InputPacer } from './inputPacer.js';

/**
 * ⭐ СЭМПЛЕР ВВОДА — ОДИН НА ОБА КЛИЕНТА (2D `NetDriver`, веб-3D `online3d`): кнопки → кадр `input` и «пора ли слать».
 *
 * Удержания сэмплируются КАЖДЫЙ кадр, а уходят с частотой тика сервера (`InputPacer`, R3-08: остаток периода
 * переносится); ФРОНТ нажатия (рывок, тогл, первый удар, [E]) уходит в том же кадре, не дожидаясь периода.
 * L2: веб-3D считал фронт только в кадр отправки (удар, нажатый и отпущенный между отправками, терялся) и обнулял
 * счётчик периода на отправке (при 60 Гц с дрожью ввод шёл то 30, то 20 раз в секунду) — теперь путь один.
 *
 * Источники — как у биндов сейва: ЛКМ `L` (`mouseLeft`), ПКМ `R` (`mouseRight`), Shift `S` / Q `Q` / Alt `A`
 * (`hotbar[0..2]`); пробел — уклонение (`dodge`), E — действие/подбор (`interact`). Чистая логика без DOM и Phaser.
 */

/** Что зажато в этом кадре (сырые удержания, фронты считает сэмплер). */
export interface HeldInput { L: boolean; R: boolean; S: boolean; Q: boolean; A: boolean; dodge: boolean; interact: boolean }

/** Бинды сейва: `'attack'`, id узла скилла или пусто. */
export interface InputBinds { mouseLeft: string | null; mouseRight: string | null; hotbar: readonly (string | null)[] }

/** Итог кадра: поля кадра `input` (без движения и взгляда — их даёт клиент) и `due` — слать ли его сейчас. */
export interface SampledInput { attack: boolean; cast: string | null; dodge: boolean; interact: boolean; due: boolean }

export class InputSampler {
  /** Предыдущее удержание по источнику — фронт-детекция тоглов, рывка и [E]. */
  private wasHeld: Record<string, boolean> = {};
  private pacer = new InputPacer();

  /**
   * Кадр ввода. `dtMs` — мс с прошлого кадра; `isToggle` — узел-тогл (аура/стойка): его каст — только по фронту,
   * иначе удержание переключало бы его каждый тик и аура «мигала». `attack` — каждый кадр, и когда не шлём (кукле веб-3D
   * нужно знать, что атака ЗАЖАТА: на конце окна комбо она продолжит цепочку).
   */
  frame(dtMs: number, binds: InputBinds, held: HeldInput, isToggle: (nodeId: string) => boolean): SampledInput {
    let attack = false;
    let cast: string | null = null;
    let press = false;   // фронт нажатия в этом кадре — уходит сразу, не дожидаясь периода
    const consider = (b: string | null | undefined, on: boolean, src: string): void => {
      const prev = this.wasHeld[src] ?? false;
      this.wasHeld[src] = on;
      if (!on || !b) return;
      if (!prev) press = true;
      if (b === 'attack') { attack = true; return; }
      if (isToggle(b) && prev) return;
      if (cast == null) cast = b;
    };
    consider(binds.mouseLeft, held.L, 'L');
    consider(binds.mouseRight, held.R, 'R');
    consider(binds.hotbar[0], held.S, 'S');
    consider(binds.hotbar[1], held.Q, 'Q');   // бывший Space-слот перевешен на Q (Space → уклонение)
    consider(binds.hotbar[2], held.A, 'A');
    // Пробел = УКЛОНЕНИЕ, эджево (только в кадр нажатия): рывок в направлении WASD (стоя — к прицелу).
    const dodge = held.dodge && !(this.wasHeld['dodge'] ?? false);
    this.wasHeld['dodge'] = held.dodge;
    // E — подбор/действие: удержание надёжно (сервер сэмплит каждый тик), фронт — сразу.
    if (held.interact && !(this.wasHeld['E'] ?? false)) press = true;
    this.wasHeld['E'] = held.interact;
    return { attack, cast, dodge, interact: held.interact, due: this.pacer.due(dtMs, press || dodge) };
  }
}
