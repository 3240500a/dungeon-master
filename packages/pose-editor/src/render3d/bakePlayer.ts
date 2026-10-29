/**
 * ⭐⭐ `BakePlayer` — КУКЛА С ПРОЦЕДУРНЫМ ПЛАНИРОВЩИКОМ ШАГОВ. Редактор и запекатель.
 *
 * Игра ходит КЛИПАМИ, и с Э13б планировщик ей недостижим в принципе. Но он никуда не делся: именно из него
 * берётся движение, которое ЗАПЕКАЕТСЯ в клипы, и именно он крутится под ползунками вкладки «Бег».
 *
 * ⚠⚠ ГРАНИЦА ПРОВЕДЕНА ВЛАДЕНИЕМ, А НЕ ФЛАГОМ. Раньше `PosePlayer` держал `readonly driver = new PoseDriver()`
 * на КАЖДОЙ кукле сцены — включая монстров и чужих игроков, — а «исполняется ли планировщик» решал флаг кадра.
 * Пока ссылка есть, дерево-шейкинг класс не выкинет, и ответ на «вырезан ли планировщик» остаётся вопросом
 * дисциплины. Теперь на него отвечает ТИП: у `PosePlayer` поля нет вовсе.
 *
 * ⚠⚠ `step()` НЕ ПЕРЕОПРЕДЕЛЁН. Он один на обе куклы: копия кадрового конвейера была бы второй правдой на самом
 * горячем месте проекта. Подменяются только ЗАЩИЩЁННЫЕ ШВЫ (`planner*` в `poseRuntime.ts`), а тернарники
 * `clipOnly ? … : шов` остаются в `step()` как были — в базе вторая ветка просто никогда не берётся.
 */
import * as THREE from 'three';
import { PoseDriver } from './stepPlanner.js';
import { GAIT, clamp, FOOT_Y, type PoseTargets } from './gaitKnobs.js';
import { PosePlayer, blendVia, DIR_STEP, type measureStancePlants } from './poseRuntime.js';

const _vfl = new THREE.Vector3(), _vfr = new THREE.Vector3();

export class BakePlayer extends PosePlayer {
  /**
   * ⚠⚠ ПЛАНИРОВЩИК ЖИВЁТ НЕ В ПОЛЕ, И ЭТО НЕ СТИЛЬ, А ЕДИНСТВЕННЫЙ РАБОЧИЙ ВАРИАНТ.
   *
   * `target: ES2022` ⇒ `useDefineForClassFields: true`: инициализаторы полей ПОДКЛАССА отрабатывают ПОСЛЕ
   * `super()`. А конструктор базы зовёт `measureStance()`, тот — шов `plannerStance`, то есть планировщик нужен
   * УЖЕ ВНУТРИ `super()`. Объяви его полем — и получишь двойную беду: во время `super()` оно `undefined`, а
   * после `super()` инициализатор ПЕРЕЗАПИШЕТ экземпляр, созданный лениво, вместе с уже переданной стойкой.
   *
   * ⚠ Сломалось бы это МОЛЧА: `PoseDriver.setStance` без планировщика только ЗАПОМИНАЕТ стойку, и потеря
   * всплыла бы позже — `StepPlanner` создаётся в `setWorld` и взял бы полутаз рига вместо замеренного.
   *
   * Поэтому хранилище — свойство, назначаемое ТОЛЬКО геттером: инициализатора нет, перезаписывать нечему.
   * Сеттер нужен сторожу `clipOnly.test.ts`, который подменяет планировщик ловушкой-`Proxy`.
   */
  get driver(): PoseDriver {
    const h = this as unknown as { __drv?: PoseDriver };
    return (h.__drv ??= new PoseDriver());
  }
  set driver(d: PoseDriver) { (this as unknown as { __drv?: PoseDriver }).__drv = d; }

  protected override get hasPlanner(): boolean { return true; }
  protected override plannerReplant(): void { this.driver.replant(); }
  protected override plannerReset(): void { this.driver.resetPlanner(); }
  protected override plannerStance(p: ReturnType<typeof measureStancePlants>): void {
    this.driver.setStance(p.latL, p.fwdL, p.latR, p.fwdR, p.standY, p.foot);
  }
  protected override plannerCombat(c: number): void { this.driver.setCombat(c); }
  protected override get plannerStepping(): boolean { return this.driver.stepping; }
  protected override plannerSwing(): readonly [boolean, boolean] { return this.driver.swingLegs; }
  protected override plannerUpdate(dt: number): PoseTargets { return this.driver.update(dt); }
  protected override get plannerPhase(): number { return this.driver.gaitPhase; }
  protected override get plannerHipsTurn(): number { return this.driver.hipsTurn; }
  protected override plannerPlant(i: 0 | 1): readonly [number, number] { return this.driver.plantTarget(i); }
  protected override plannerGroundW(): readonly [number, number] { return this.driver.groundWeights; }
  protected override plannerPlantW(): readonly [number, number] { return this.driver.plantWeights; }

  /** Весь вход кадра. Переехал из `PosePlayer.step` целиком — вместе с плант-сеткой, которую читает только он. */
  protected override plannerFeed(yaw: number, vx: number, vz: number, spd: number, fwdC: number, latC: number): void {
    this.driver.footFloor = this.human.ankleRest ?? (FOOT_Y + (this.human.footLift ?? 0));
    this.driver.legRest = this.human.legRest;   // длины бедра/голени и полутаз — из рига, не из констант
    this.driver.setWorld(this.px, this.pz, yaw, vx, vz);   // yaw таза → стопы в верном body-кадре + подшаг при повороте
    this.driver.setGoalYaw(this.aimYaw);                   // прицел → подшаг целит в идл-стойку ПОСЛЕ доворота (не в промежуток)
    // ⚠ ЯЧЕЙКИ СЕТКИ — В ЛОКАЛЬНЫХ ОСЯХ: 0 = вперёд (+Z), 2 = +X = СВОЯ ЛЕВАЯ сторона (клип `strafe_R`),
    // 4 = назад, 6 = −X = СВОЯ ПРАВАЯ (клип `strafe_L`). См. «ТАБЛИЦА ИСТИНЫ «СТОРОНА»» в `gaitKnobs.ts`.
    let ang = Math.atan2(latC, fwdC) / DIR_STEP; ang = ((ang % 8) + 8) % 8;   // направление плант-сетки (тело-локальное)
    const i0 = Math.floor(ang) % 8, i1 = (i0 + 1) % 8, ft = ang - Math.floor(ang);
    // ⚠ ПОД СЕКТОРАМИ ЯЧЕЙКУ НЕ «ПРИЩЁЛКИВАЕМ» К ОСИ СЕКТОРА, хотя диагональные ячейки задеваются только на перебросе.
    // Пробовал: переброс меняет ячейку скачком (ходьба «вправо» [−9, 1.86] → «назад» [−5, 0]), и планировщик ловит
    // рывок. ЗАМЕР (рыцарь, опубликованный воин, доворот 45°, планировщик): поворот прицела 90°/с — скачок голени
    // 41.2° (p99 29.4) с прищёлкиванием против 32.2° (p99 22.2) без; ход 120°→150° — 33.4° против 20.7°. Угол в
    // осях довёрнутого таза едет НЕПРЕРЫВНО (доворот сглажен), и сетка вслед за ним — тоже. Косые ячейки — данные
    // автора: редактор показывает «не зеркально» и зеркалит по кнопке.
    const spB = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
    const bl = (leg: 'l' | 'r', k: 0 | 1): number => {
      const w = this.plant.walk[i0]![leg][k] + (this.plant.walk[i1]![leg][k] - this.plant.walk[i0]![leg][k]) * ft;
      const r = this.plant.run[i0]![leg][k] + (this.plant.run[i1]![leg][k] - this.plant.run[i0]![leg][k]) * ft;
      return w + (r - w) * spB;
    };
    this.driver.setPlantOffset(bl('l', 0), bl('l', 1), bl('r', 0), bl('r', 1));
    this.driver.setPlantVia(blendVia(this.plant, 'lVia', i0, i1, ft, spB), blendVia(this.plant, 'rVia', i0, i1, ft, spB));
  }

  /** Ноги отобраны слоем действия / поворотом + фидбэк фактических стоп. */
  protected override plannerLegs(held: boolean, feedback: boolean): void {
    this.driver.setLegsHeld(held);
    if (!feedback) return;
    const fl = this.human.bones.get('LeftFoot')!.getWorldPosition(_vfl);
    const fr = this.human.bones.get('RightFoot')!.getWorldPosition(_vfr);
    // ⚠ ВЫЧИТАЕМ СВОЙ СОБСТВЕННЫЙ ПОВОРОТ ТАЗА (`turnFeet` прошлого кадра — риг сейчас именно такой). Фидбэк
    // существует, чтобы ловить ФИЗИКУ, а не нашу же авторскую позу: не вычесть — и планировщик прибьёт плант к
    // уехавшей стопе, а дальше погонится за собственным хвостом (ЗАМЕР: расхождение плантов 0 → 28 ед. за 8 с
    // при повороте 35°; с вычетом — 0.000e+0 бит в бит).
    const t = this.turnFeet;
    this.driver.setFeet(fl.x + this.px - t[0], fl.z + this.pz - t[1], fr.x + this.px - t[2], fr.z + this.pz - t[3]);
  }
}
