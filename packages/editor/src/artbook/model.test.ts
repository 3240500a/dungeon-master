import { describe, it, expect } from 'vitest';
import {
  EMPTY_ARTBOOK, normalizeArtbook, getAt, setAt, applyTexts, textState, editText, resetText, keepEdit, editStats,
  slotKey, addImage, updateImage, setMain, removeImage, moveImage, mainOf, coverOf, slotState, slotImages,
  imageContentType, uploadId, uploadProblem, MAX_UPLOAD_BYTES, mergeArtbook, canonArtbook, type ArtbookDoc,
} from './model.js';

/**
 * ⭐ 16.10 (Артбук): ядро правок. Главное обещание — ОБНОВЛЕНИЕ СИДА НЕ ЗАТИРАЕТ ПРАВКИ ВЛАДЕЛЬЦА, а нетронутые поля едут с
 * сидом. Плюс путь поля держится за ключ строки, а не за индекс: перестановка строк в сиде правку не переносит на соседа.
 */
const seedV1 = () => ({
  crypt: {
    intro: { purpose: ['абзац 1', 'абзац 2'] },
    subtypes: [
      { id: 'greece', name: 'Посеянные', lore: 'старый лор Греции' },
      { id: 'rome', name: 'Непогребённый легион', lore: 'лор Рима' },
    ],
    decayLadder: { rows: [{ subtype: 'rome', body: 'иссохшие' }] },
  },
});

describe('artbook: пути полей', () => {
  it('ключ строки (id/subtype), индекс и ключи объекта', () => {
    const s = seedV1();
    expect(getAt(s, 'crypt/subtypes/rome/lore')).toBe('лор Рима');
    expect(getAt(s, 'crypt/subtypes/1/name')).toBe('Непогребённый легион');
    expect(getAt(s, 'crypt/decayLadder/rows/rome/body')).toBe('иссохшие');
    expect(getAt(s, 'crypt/intro/purpose/1')).toBe('абзац 2');
    expect(getAt(s, 'crypt/subtypes/vikings/lore')).toBeUndefined();
    expect(getAt(s, 'crypt/intro/purpose/9')).toBeUndefined();
  });

  it('setAt: создаёт недостающий ключ объекта, но не строку массива', () => {
    const s = seedV1() as Record<string, unknown>;
    expect(setAt(s, 'loc/crypt/artNotes', 'заметка')).toBe(true);
    expect(getAt(s, 'loc/crypt/artNotes')).toBe('заметка');
    expect(setAt(s, 'crypt/subtypes/vikings/lore', 'x')).toBe(false);
    expect(setAt(s, 'crypt/intro/purpose/0', 'новый')).toBe(true);
    expect(getAt(s, 'crypt/intro/purpose/0')).toBe('новый');
  });
});

describe('artbook: сид + правки', () => {
  it('правка поверх сида; сид не мутируется', () => {
    const seed = seedV1();
    const doc = EMPTY_ARTBOOK();
    expect(editText(doc, seed, 'crypt/subtypes/greece/lore', 'лор владельца', 10)).toBe(true);
    const view = applyTexts(seed, doc.texts);
    expect(getAt(view, 'crypt/subtypes/greece/lore')).toBe('лор владельца');
    expect(getAt(seed, 'crypt/subtypes/greece/lore')).toBe('старый лор Греции');
    expect(doc.texts['crypt/subtypes/greece/lore']).toEqual({ text: 'лор владельца', base: 'старый лор Греции', at: 10 });
  });

  it('⭐ НОВЫЙ СИД: правка владельца остаётся, нетронутые поля едут с сидом, правленое помечено «сид обновился»', () => {
    const doc = EMPTY_ARTBOOK();
    editText(doc, seedV1(), 'crypt/subtypes/greece/lore', 'лор владельца', 10);
    // сид v2: строки переставлены, лор Греции переписан, лор Рима переписан, добавлен подтип
    const seedV2 = {
      crypt: {
        intro: { purpose: ['абзац 1 (новый)', 'абзац 2'] },
        subtypes: [
          { id: 'vikings', name: 'Мёрзлая дружина', lore: 'лор викингов' },
          { id: 'rome', name: 'Непогребённый легион', lore: 'новый лор Рима' },
          { id: 'greece', name: 'Посеянные', lore: 'НОВЫЙ лор Греции' },
        ],
        decayLadder: { rows: [{ subtype: 'rome', body: 'иссохшие' }] },
      },
    };
    const view = applyTexts(seedV2, doc.texts);
    expect(getAt(view, 'crypt/subtypes/greece/lore'), 'правка владельца не затёрта').toBe('лор владельца');
    expect(getAt(view, 'crypt/subtypes/rome/lore'), 'нетронутое — из нового сида').toBe('новый лор Рима');
    expect(getAt(view, 'crypt/subtypes/vikings/lore')).toBe('лор викингов');
    expect(getAt(view, 'crypt/intro/purpose/0')).toBe('абзац 1 (новый)');
    const st = textState(seedV2, doc, 'crypt/subtypes/greece/lore');
    expect(st).toEqual({ value: 'лор владельца', seedValue: 'НОВЫЙ лор Греции', edited: true, stale: true });
    expect(textState(seedV2, doc, 'crypt/subtypes/rome/lore').edited).toBe(false);
    expect(editStats(seedV2, doc)).toEqual({ edited: 1, stale: 1 });
    // «оставить своё» — пометка гаснет, текст владельца прежний
    expect(keepEdit(doc, seedV2, 'crypt/subtypes/greece/lore', 20)).toBe(true);
    expect(textState(seedV2, doc, 'crypt/subtypes/greece/lore')).toMatchObject({ value: 'лор владельца', stale: false });
    // «взять текст сида» — правка снимается
    expect(resetText(doc, 'crypt/subtypes/greece/lore', 30)).toBe(true);
    expect(textState(seedV2, doc, 'crypt/subtypes/greece/lore')).toMatchObject({ value: 'НОВЫЙ лор Греции', edited: false });
  });

  it('правка, равная сиду, снимается; пустая строка — тоже правка; повтор той же — не изменение', () => {
    const seed = seedV1();
    const doc = EMPTY_ARTBOOK();
    expect(editText(doc, seed, 'crypt/intro/purpose/0', 'абзац 1', 1)).toBe(false);
    expect(editText(doc, seed, 'crypt/intro/purpose/0', '', 2)).toBe(true);
    expect(getAt(applyTexts(seed, doc.texts), 'crypt/intro/purpose/0')).toBe('');
    expect(editText(doc, seed, 'crypt/intro/purpose/0', '', 3)).toBe(false);
    expect(editText(doc, seed, 'crypt/intro/purpose/0', 'абзац 1', 4)).toBe(true);
    expect(doc.texts).toEqual({});
  });

  it('поле, которого в сиде нет (заметка у биома): правка живёт, пустую не заводим', () => {
    const seed = seedV1();
    const doc = EMPTY_ARTBOOK();
    expect(editText(doc, seed, 'loc/caves/artNotes', '', 1)).toBe(false);
    expect(editText(doc, seed, 'loc/caves/artNotes', 'мох и кости', 2)).toBe(true);
    expect(doc.texts['loc/caves/artNotes']).toEqual({ text: 'мох и кости', at: 2 });
    expect(textState(seed, doc, 'loc/caves/artNotes')).toEqual({ value: 'мох и кости', seedValue: undefined, edited: true, stale: false });
  });

  it('строку убрали из сида — правка не падает и не теряется', () => {
    const doc = EMPTY_ARTBOOK();
    editText(doc, seedV1(), 'crypt/subtypes/rome/lore', 'мой Рим', 1);
    const seedNoRome = { crypt: { subtypes: [{ id: 'greece', lore: 'g' }] } };
    expect(() => applyTexts(seedNoRome, doc.texts)).not.toThrow();
    expect(doc.texts['crypt/subtypes/rome/lore']?.text).toBe('мой Рим');
  });
});

describe('artbook: картинки в слотах', () => {
  const K = slotKey('sub', 'greece', 'concept');
  it('ключ слота', () => {
    expect(K).toBe('sub:greece:concept');
    expect(slotKey('arch', 'a:b', 'rome', 'concept')).toBe('arch:a_b:rome:concept');
  });

  it('первая — главная; ★ ровно одна; удаление главной передаёт ★ первой', () => {
    const doc = EMPTY_ARTBOOK();
    addImage(doc, K, { id: 'a', url: '/assets/artbook/a.png' }, 1);
    addImage(doc, K, { id: 'b', url: '/assets/artbook/b.png' }, 2);
    addImage(doc, K, { id: 'c', url: '/assets/artbook/c.png' }, 3);
    expect(slotImages(doc, K).filter((x) => x.main).map((x) => x.id)).toEqual(['a']);
    expect(setMain(doc, K, 'c', 4)).toBe(true);
    expect(slotImages(doc, K).filter((x) => x.main).map((x) => x.id)).toEqual(['c']);
    expect(setMain(doc, K, 'c', 5), 'уже главная').toBe(false);
    expect(removeImage(doc, K, 'c', 6)).toBe(true);
    expect(mainOf(slotImages(doc, K))?.id).toBe('a');
    expect(moveImage(doc, K, 'b', -1, 7)).toBe(true);
    expect(slotImages(doc, K).map((x) => x.id)).toEqual(['b', 'a']);
    expect(removeImage(doc, K, 'a', 8) && removeImage(doc, K, 'b', 9)).toBe(true);
    expect(doc.slots[K], 'пустой слот убирается из документа').toBeUndefined();
  });

  it('обложка — только утверждённая; сводный статус слота', () => {
    const doc = EMPTY_ARTBOOK();
    expect(slotState(slotImages(doc, K))).toBe('none');
    addImage(doc, K, { id: 'a', url: 'u/a' }, 1);
    addImage(doc, K, { id: 'b', url: 'u/b' }, 2);
    expect(slotState(slotImages(doc, K))).toBe('draft');
    expect(coverOf(slotImages(doc, K)), 'черновик обложкой не бывает').toBeUndefined();
    expect(updateImage(doc, K, 'b', { status: 'approved', caption: 'вариант Б' }, 3)).toBe(true);
    expect(coverOf(slotImages(doc, K))?.id, 'главная не утверждена — первая утверждённая').toBe('b');
    updateImage(doc, K, 'a', { status: 'approved' }, 4);
    expect(coverOf(slotImages(doc, K))?.id, 'утверждённая главная').toBe('a');
    expect(slotState(slotImages(doc, K))).toBe('approved');
    expect(updateImage(doc, K, 'a', { status: 'approved' }, 5), 'без изменений').toBe(false);
  });

  it('normalize: мусор → пустой документ; картинка без адреса отбрасывается; две ★ → одна', () => {
    expect(normalizeArtbook(null)).toEqual(EMPTY_ARTBOOK());
    expect(normalizeArtbook('x')).toEqual(EMPTY_ARTBOOK());
    const d = normalizeArtbook({
      updatedAt: 5,
      texts: { 'a/b': { text: 't', base: 'b', at: 1 }, bad: { text: 3 } },
      slots: { k: [{ id: '1', url: 'u1', main: true, status: 'approved' }, { id: '2', url: 'u2', main: true, status: 'weird' }, { id: '3' }], empty: [] },
    });
    expect(d.updatedAt).toBe(5);
    expect(Object.keys(d.texts)).toEqual(['a/b']);
    expect(d.slots.k!.map((x) => [x.id, !!x.main, x.status])).toEqual([['1', true, 'approved'], ['2', false, 'none']]);
    expect(d.slots.empty).toBeUndefined();
  });
});

describe('artbook: слияние двух машин', () => {
  const K = 'sub:rome:concept';
  const seed = { crypt: { subtypes: [{ id: 'rome', lore: 'сид' }, { id: 'greece', lore: 'сид Г' }] } };
  const fork = (d: ArtbookDoc): ArtbookDoc => normalizeArtbook(JSON.parse(JSON.stringify(d)));

  it('картинки с одной машины и тексты с другой — сходятся без потерь, в любом порядке слияния', () => {
    const base = EMPTY_ARTBOOK();
    addImage(base, K, { id: 'a', url: 'u/a' }, 1);
    const m1 = fork(base), m2 = fork(base);
    addImage(m1, K, { id: 'b', url: 'u/b' }, 10);             // машина 1: вторая картинка
    updateImage(m1, K, 'a', { status: 'approved' }, 11);
    editText(m2, seed, 'crypt/subtypes/rome/lore', 'правка 2', 12);   // машина 2: текст
    updateImage(m2, K, 'a', { caption: 'подпись 2' }, 13);   // и подпись той же картинки — позже статуса машины 1
    const x = mergeArtbook(m1, m2), y = mergeArtbook(m2, m1);
    expect(slotImages(x, K).map((i) => i.id)).toEqual(['a', 'b']);
    expect(x.texts['crypt/subtypes/rome/lore']?.text).toBe('правка 2');
    expect(slotImages(x, K)[0], 'поле — от своей поздней правки: подпись машины 2, статус машины 1').toMatchObject({ caption: 'подпись 2', status: 'approved' });
    expect(slotImages(y, K)[0]).toMatchObject({ caption: 'подпись 2', status: 'approved' });
    expect(canonArtbook(mergeArtbook(x, y))).toBe(canonArtbook(x));
    expect(new Set(slotImages(y, K).map((i) => i.id))).toEqual(new Set(['a', 'b']));
  });

  it('удалённое на одной машине не воскресает со второй; ★ — у последней отмеченной', () => {
    const base = EMPTY_ARTBOOK();
    addImage(base, K, { id: 'a', url: 'u/a' }, 1);
    addImage(base, K, { id: 'b', url: 'u/b' }, 2);
    editText(base, seed, 'crypt/subtypes/greece/lore', 'старая правка', 3);
    const m1 = fork(base), m2 = fork(base);
    removeImage(m1, K, 'a', 10);
    resetText(m1, 'crypt/subtypes/greece/lore', 11);
    addImage(m2, K, { id: 'c', url: 'u/c' }, 12);
    setMain(m2, K, 'c', 13);
    const x = mergeArtbook(m2, m1);
    expect(slotImages(x, K).map((i) => i.id)).toEqual(['b', 'c']);
    expect(mainOf(slotImages(x, K))?.id).toBe('c');
    expect(x.texts['crypt/subtypes/greece/lore'], 'снятая правка не вернулась').toBeUndefined();
    // правка ПОСЛЕ снятия — живёт
    editText(m2, seed, 'crypt/subtypes/greece/lore', 'новая правка', 20);
    expect(mergeArtbook(m1, m2).texts['crypt/subtypes/greece/lore']?.text).toBe('новая правка');
  });

  it('⭐ порядок (← →) — у копии с более поздней перестановкой: вторая машина не переписывает его своим старым', () => {
    const base = EMPTY_ARTBOOK();
    for (const [i, id] of ['a', 'b', 'c'].entries()) addImage(base, K, { id, url: 'u/' + id }, i + 1);
    const m1 = fork(base), m2 = fork(base);
    moveImage(m1, K, 'c', -1, 10); moveImage(m1, K, 'c', -1, 11);         // машина 1: c — в начало
    addImage(m2, K, { id: 'd', url: 'u/d' }, 12);                            // машина 2: только новая картинка
    for (const x of [mergeArtbook(m1, m2), mergeArtbook(m2, m1)]) expect(slotImages(x, K).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
    moveImage(m2, K, 'a', 1, 20);                                            // а потом переставила и вторая — её порядок новее
    expect(slotImages(mergeArtbook(m1, m2), K).map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(normalizeArtbook(JSON.parse(JSON.stringify(m2))).ord[K], 'отметка переживает хранилище').toBe(20);
  });

  it('слияние с пустым — то же самое', () => {
    const d = EMPTY_ARTBOOK();
    addImage(d, K, { id: 'a', url: 'u/a', caption: 'c' }, 1);
    editText(d, seed, 'crypt/subtypes/rome/lore', 'т', 2);
    expect(canonArtbook(mergeArtbook(d, EMPTY_ARTBOOK()))).toBe(canonArtbook(d));
    expect(canonArtbook(mergeArtbook(EMPTY_ARTBOOK(), d))).toBe(canonArtbook(d));
  });
});

describe('artbook: загрузка файлов', () => {
  it('тип содержимого — только png/jpeg/webp (их и принимает сервер)', () => {
    expect(imageContentType('a.PNG')).toBe('image/png');
    expect(imageContentType('a.jpeg')).toBe('image/jpeg');
    expect(imageContentType('x', 'image/webp')).toBe('image/webp');
    expect(imageContentType('a.gif', 'image/gif')).toBeNull();
    expect(imageContentType('a.psd')).toBeNull();
    expect(imageContentType('art.png', 'image/gif'), 'gif, переименованный в .png, — не картинка').toBeNull();
    expect(imageContentType('art.jpg', 'image/jpg')).toBe('image/jpeg');
    expect(imageContentType('art.webp', 'application/octet-stream'), 'тип неизвестен браузеру — решает расширение').toBe('image/webp');
  });

  it('проверка до заливки: не картинка, пустой файл, больше предела сервера — текст для слота; годный — null', () => {
    expect(uploadProblem('a.png', 'image/png', 1024)).toBeNull();
    expect(uploadProblem('a.png', 'image/png', MAX_UPLOAD_BYTES)).toBeNull();
    expect(uploadProblem('a.psd', '', 10)).toMatch(/не картинка/);
    expect(uploadProblem('a.png', 'image/png', 0)).toMatch(/пустой/);
    expect(uploadProblem('a.png', 'image/png', MAX_UPLOAD_BYTES + 1)).toMatch(/64 МБ/);
  });

  it('id файла — из набора, который сервер не режет; разный на каждую заливку', () => {
    const a = uploadId('arch:rank_and_file:greece:concept', 1_700_000_000_000, 12345);
    const b = uploadId('arch:rank_and_file:greece:concept', 1_700_000_000_001, 12345);
    expect(a).toMatch(/^ab_[a-zA-Z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(uploadId('loc:крипта:слот', 1, 1)).toMatch(/^ab_[a-zA-Z0-9_-]+$/);
  });
});
