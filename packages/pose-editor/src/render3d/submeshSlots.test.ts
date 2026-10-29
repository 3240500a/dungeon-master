import { describe, it, expect } from 'vitest';
import { classifySubmesh, classifyAtlas, BODY_SLOTS } from './modelSkin.js';

/**
 * СЛОТ ДЕТАЛИ = ПРЕФИКС ЕЁ ИМЕНИ, и ничего кроме.
 *
 * Договорённость с художником: `helm_…`, `head_…`, `chest_…`, `gloves_…`, `boots_…`. Всё остальное
 * не опознаётся — это НЕ недоработка, а требование автора: «смотреть только на префиксы, остальное
 * игнорировать».
 *
 * ⚠ Раньше слот УГАДЫВАЛСЯ по десятку подстрок в имени (`armor|plate|torso|body|cloth` — в грудь,
 * `hand|glove|gaunt|wrist` — в перчатки…), причём порядок проверок был значим. Угадывание ошибалось
 * молча: деталь уезжала не в тот слот, и понять почему было неоткуда.
 */
describe('слот берётся из префикса', () => {
  it('⭐ все пять префиксов узнаются', () => {
    expect(classifySubmesh('helm_01')).toBe('helm');
    expect(classifySubmesh('head_01')).toBe('head');
    expect(classifySubmesh('chest_01')).toBe('chest');
    expect(classifySubmesh('gloves_01')).toBe('gloves');
    expect(classifySubmesh('boots_01')).toBe('boots');
  });

  it('регистр и разделитель не важны, лишь бы префикс был отдельным словом', () => {
    expect(classifySubmesh('Helm_01')).toBe('helm');
    expect(classifySubmesh('HELM.001')).toBe('helm');
    expect(classifySubmesh('boots-2')).toBe('boots');
    expect(classifySubmesh('  chest_plate_01  ')).toBe('chest');
    expect(classifySubmesh('head')).toBe('head');
  });

  it('⭐ ВСЁ ОСТАЛЬНОЕ НЕ ОПОЗНАЁТСЯ — включая старые «говорящие» имена', () => {
    // Именно это и просили: никаких догадок. Прежняя эвристика разложила бы их по слотам.
    for (const n of ['barbute_01', 'bascinet_02', 'body_01', 'hauberk_01', 'hair_02', 'chainmail_legs_01']) {
      expect(classifySubmesh(n), n).toBe('');
    }
  });

  it('⚠ `helmet_01` — НЕ шлем: префикс обязан кончаться на не-букве', () => {
    // Спорный на вид случай, и он осознанный: «почти совпало» — это снова угадывание.
    expect(classifySubmesh('helmet_01')).toBe('');
    expect(classifySubmesh('heads_up')).toBe('');
    expect(classifySubmesh('chestnut')).toBe('');
  });

  it('карта атласа раскладывает набор имён и оставляет чужое пустым', () => {
    const map = classifyAtlas(['helm_a', 'chest_b', 'weird_thing', 'boots_c']);
    expect(map).toEqual({ helm_a: 'helm', chest_b: 'chest', weird_thing: '', boots_c: 'boots' });
  });

  it('список слотов и префиксы — одно и то же (иначе слот появится, а имени под него не будет)', () => {
    for (const s of BODY_SLOTS) expect(classifySubmesh(`${s}_01`), s).toBe(s);
  });
});
