/**
 * ⭐⭐ Г6 (14.10): СТОРОЖ ОПЫТА — ШТРАФ ЗА РАЗНИЦУ УРОВНЕЙ (форма PoE) И ДЕЛЕЖ НА ПАТИ.
 *
 * ЗАЧЕМ. До Г6 штрафа не было ВОВСЕ и опыт не делился: самой выгодной игрой было стоять в углу, пока тебя тащат по
 * глубине. С Г1 уровень монстра — это НОМЕР ЭТАЖА, поэтому «тащат» значит «посадили на этаж не по зубам», и без
 * штрафа низкий герой снимал бы там полный опыт этажа; обратная сторона — герой 80-го уровня на 10-м этаже обязан
 * получать крохи, иначе глубина не нужна.
 *
 * Что файл обязан валить: снятие штрафа (множитель 1 при любом разрыве); обрыв вместо плавного спада; пол 0 (опыт
 * «не считается вовсе»); дележ, который печатает опыт (сумма долей > 1); потерю минимальной единицы (на мелком
 * монстре большая пати получала бы ноль, и полоса стояла бы).
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { xpLevelMult, xpPartyShare, xpForKill, type XpShareBalance } from './xp.js';

/** Числа — ЖИВЫЕ из `balance.json` (правило проекта: значение живёт в данных, не в `.default()`). */
const B: XpShareBalance = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.get('balance').xpShare; })();

/** Таблица «разрыв уровней → процент опыта» — её числа и есть ответ владельцу «а сколько это». */
function row(level: number, diffs: number[]): string {
  return `ур. ${String(level).padStart(2)}: ` + diffs.map((d) => `${d >= 0 ? '+' : ''}${d} → ${(xpLevelMult(level, level + d, B) * 100).toFixed(1)}%`).join('  ');
}

describe('⭐⭐ Г6: опыт — штраф за уровень и дележ', () => {
  it('ПОЛОСА БЕЗ ШТРАФА — 3 + уровень/16 (PoE): внутри неё ровно 1, на границе ещё 1', () => {
    // 20 ур. → floor(3 + 1.25) = 4; 80 ур. → floor(3 + 5) = 8.
    for (const d of [-4, -1, 0, 1, 4]) expect(xpLevelMult(20, 20 + d, B), `разрыв ${d} на 20 ур.`).toBe(1);
    for (const d of [-8, 0, 8]) expect(xpLevelMult(80, 80 + d, B), `разрыв ${d} на 80 ур.`).toBe(1);
    expect(xpLevelMult(20, 25, B)).toBeLessThan(1);   // шаг за полосу — уже штраф
    expect(xpLevelMult(80, 89, B)).toBeLessThan(1);
  });

  it('СПАД ПЛАВНЫЙ И МОНОТОННЫЙ, с полом 1 % — не обрыв D2 (±5, потом сразу 5 %)', () => {
    const seq = [5, 6, 7, 8, 10, 12, 15, 20, 30].map((d) => xpLevelMult(20, 20 + d, B));
    for (let i = 1; i < seq.length; i++) expect(seq[i]!, `разрыв растёт — опыт не растёт (шаг ${i})`).toBeLessThanOrEqual(seq[i - 1]!);
    // Ни одного обрыва больше чем в 2.2 раза между соседними шагами полосы (у D2 он 20-кратный).
    const step = [5, 6, 7, 8, 9, 10].map((d) => xpLevelMult(20, 20 + d, B));
    for (let i = 1; i < step.length; i++) expect(step[i - 1]! / step[i]!, `обрыв на шаге ${i}`).toBeLessThan(2.2);
    expect(Math.min(...seq)).toBeGreaterThanOrEqual(B.floor);
    expect(xpLevelMult(20, 200, B), 'глубина 200 герою 20-го уровня — пол, а не ноль').toBe(B.floor);
    console.log(`\nГ6 ШТРАФ ЗА РАЗНИЦУ УРОВНЕЙ (форма PoE, пол ${B.floor * 100} %)\n`
      + [1, 20, 50, 80, 99].map((L) => row(L, [0, 5, 8, 10, 15, 25, 50])).join('\n'));
  });

  it('ВЫШЕ УРОВЕНЬ — МЯГЧЕ ШТРАФ ЗА ТОТ ЖЕ РАЗРЫВ (опора L + 5)', () => {
    const d = 12;
    const low = xpLevelMult(10, 10 + d, B), high = xpLevelMult(90, 90 + d, B);
    expect(high).toBeGreaterThan(low);
    console.log(`Г6 тот же разрыв +${d}: на 10 ур. ${(low * 100).toFixed(2)} %, на 90 ур. ${(high * 100).toFixed(2)} %`);
  });

  it('СИММЕТРИЯ: монстр ниже героя наказан так же, как монстр выше — глубина важна в обе стороны', () => {
    expect(xpLevelMult(50, 30, B)).toBe(xpLevelMult(50, 70, B));
  });

  it('ДЕЛЕЖ: один — всё; надбавка 0 даёт ровно 1/n; штатная надбавка 0.5 — 75 % вдвоём, и никогда больше 1', () => {
    expect(xpPartyShare(1, B)).toBe(1);
    // ⚠ БЕЗ НАДБАВКИ дележ обязан быть ровным: сумма долей — ровно опыт монстра, из воздуха не печатается.
    const plain: XpShareBalance = { ...B, partyBonusPerMember: 0 };
    for (const n of [2, 3, 5, 8]) expect(xpPartyShare(n, plain) * n, `сумма долей пати ${n} без надбавки`).toBeCloseTo(1, 12);
    // ⭐⭐ 15.10 (решение владельца): штатная надбавка 0.5 — вдвоём 75 %, втроём 66.7 %, впятером 60 %; платит за неё
    // жизнь монстра (+50 % за игрока), см. зуб «кооп нейтрален» ниже.
    expect([2, 3, 5].map((n) => +(xpPartyShare(n, B) * 100).toFixed(1))).toEqual([75, 66.7, 60]);
    for (const n of [2, 3, 5, 8, 20]) expect(xpPartyShare(n, B), `доля пати ${n} не больше полного опыта`).toBeLessThanOrEqual(1);
    // И доля монотонно убывает с размером пати — иначе набирать народ было бы чистой фармой.
    const seq = [1, 2, 3, 5, 8].map((n) => xpPartyShare(n, B));
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThan(seq[i - 1]!);
    // Надбавка 1 — «дележа нет»; полный опыт каждому, но не больше.
    const full: XpShareBalance = { ...B, partyBonusPerMember: 1 };
    expect(xpPartyShare(5, full)).toBe(1);
    const half: XpShareBalance = { ...B, partyBonusPerMember: 0.5 };
    expect(xpPartyShare(3, half)).toBeCloseTo((1 + 0.5 * 2) / 3, 12);
  });

  it('МИНИМАЛЬНАЯ ЕДИНИЦА: мелкий монстр большой пати даёт 1, а не 0 — иначе полоса стоит', () => {
    // xp 12, пятеро, штраф у пола: 12 × 0.01 × 0.2 = 0.024 → 1.
    expect(xpForKill(12, 20, 200, 5, B)).toBe(1);
    // Нулевой опыт монстра так и остаётся нулём (нечего делить).
    expect(xpForKill(0, 20, 20, 5, B)).toBe(0);
  });

  it('ЦЕЛЬНЫЙ СЧЁТ: опыт этажа своей глубины делится поровну, чужой — почти не идёт', () => {
    const xp = 1000;
    const solo = xpForKill(xp, 60, 60, 1, B);
    const duo = xpForKill(xp, 60, 60, 2, B);
    const carried = xpForKill(xp, 10, 60, 2, B);   // 10-й уровень на 60-м этаже
    expect(solo).toBe(1000);
    expect(duo, 'вдвоём по 75 % — надбавка за размер пати (её платит жизнь монстра)').toBe(750);
    expect(carried).toBeLessThan(solo * 0.02);
    console.log(`Г6 ЗАМЕР: монстр ${xp} xp на 60-м этаже — соло ${solo}, вдвоём по ${duo},`
      + ` протащенный 10-го уровня ${carried} (${((carried / solo) * 100).toFixed(2)} % от соло)`);
  });

  it('МУСОР НА ВХОДЕ не роняет счёт: NaN/минус/дробь — как уровень 1 и пати 1', () => {
    expect(xpLevelMult(Number.NaN, 20, B)).toBe(xpLevelMult(1, 20, B));
    expect(xpLevelMult(20, Number.POSITIVE_INFINITY, B)).toBe(xpLevelMult(20, 1, B));
    expect(xpPartyShare(Number.NaN, B)).toBe(1);
    expect(xpPartyShare(0, B)).toBe(1);
    expect(xpForKill(Number.NaN, 20, 20, 2, B)).toBe(0);
  });

  it('⭐⭐ КООП НЕЙТРАЛЕН ПО ОПЫТУ В СЕКУНДУ: надбавка 50 % и жизнь +50 % за игрока гасят друг друга ТОЧНО', () => {
    // ⚠⚠ ЭТО И ЕСТЬ ПРИЧИНА, ПО КОТОРОЙ ЧИСЛА РАВНЫ (решение владельца 15.10: «надбавка 50 % и монстры жирнее
    // примерно на 50 %»). Считаем опыт в секунду на одного игрока при линейном уроне пати (n игроков бьют ×n):
    //   время убийства = время_соло × (1 + hp×(n−1)) / n,  доля = (1 + bonus×(n−1)) / n
    //   опыт/сек = доля / время = соло × n/(1 + hp×(n−1)) × (1 + bonus×(n−1))/n
    // при hp = bonus множители сокращаются и остаётся РОВНО соло. Разойдутся числа — кооп станет либо фармой,
    // либо наказанием, и этот сторож это поймает.
    const hp = new ConfigRegistry();
    hp.loadAll();
    const coopHp = hp.get('balance').coop.hpPerExtraPlayer;
    expect([coopHp, B.partyBonusPerMember], 'ручки парные — числа равны').toEqual([0.5, 0.5]);
    const rows: string[] = [];
    for (const n of [1, 2, 3, 5]) {
      const timeMult = (1 + coopHp * (n - 1)) / n;            // жизнь выросла, урон пати вырос — время убийства
      const perSec = xpPartyShare(n, B) / timeMult;           // доля / время = опыт в секунду на игрока
      rows.push(`${n}: жизнь ×${(1 + coopHp * (n - 1)).toFixed(2)}, время ×${timeMult.toFixed(3)}, доля ${(xpPartyShare(n, B) * 100).toFixed(1)} % → опыт/сек ×${perSec.toFixed(3)}`);
      expect(perSec, `опыт в секунду у пати ${n}`).toBeCloseTo(1, 12);
    }
    console.log('Г6 КООП (жизнь +' + coopHp * 100 + ' % за игрока, надбавка +' + B.partyBonusPerMember * 100 + ' %)\n' + rows.join('\n'));
  });

  it('ВЫКЛЮЧАЕТСЯ ОДНИМ ЧИСЛОМ: `floor: 1` — штрафа нет (нужно владельцу для проб)', () => {
    const off: XpShareBalance = { ...B, floor: 1 };
    for (const d of [0, 10, 50, 500]) expect(xpLevelMult(20, 20 + d, off), `разрыв ${d}`).toBe(1);
  });
});
