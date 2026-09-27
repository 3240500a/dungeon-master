import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, PRICE_CHANGED, allocPassive, newBotSave, type SaveState, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { CmdReply } from '../../net/cmdReplies.js';
import { neighborsOf, passiveNodeCost } from './allocate.js';
import { renderPassiveTree } from './treeView.js';

/**
 * ⭐ R7-21: ДВОЙНОЙ КЛИК ПО УЗЛУ МАСТЕРСТВА — НЕ «ЦЕНА ИЗМЕНИЛАСЬ». Узел шлёт цену своей карточки (`maxGold`, R6-16), а ранг
 * для неё берётся при отрисовке. Два клика быстрее ответа сервера уходили ОБА с ценой ранга r: сервер поднимал ранг
 * первым, а второй отказывал «Цена изменилась» (цена ранга r+1 вдвое выше) — игрок видел ложный отказ, а клиент зря
 * перечитывал конфиг. Теперь ранг узла в полёте — второй клик по нему ждёт ответа; ответ пришёл (сейв уже новый, окно
 * перерисовано) — следующий клик несёт цену следующего ранга.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется окно.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; innerHTML = ''; disabled = false; parent: El | null = null;
  clientWidth = 0; clientHeight = 0;
  attrs: Record<string, string> = {};
  private on = new Map<string, ((e: unknown) => void)[]>();
  constructor(public tag: string) { }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, f: (e: unknown) => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  click(): void { for (const f of this.on.get('click') ?? []) f({ stopPropagation() { }, preventDefault() { } }); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const tree = reg.get('mastery-tree');
const mult = reg.get('balance').passiveRankCostMult;

describe('⭐ R7-21: двойной клик по узлу мастерства', () => {
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  beforeEach(() => {
    G.document = { createElement: (t: string) => new El(t), createElementNS: (_ns: string, t: string) => new El(t), body: new El('body') };
    G.window = { addEventListener() { } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  /**
   * Герой с вложенным входом и узел-сосед в несколько рангов. Сервер отвечает ПОЗЖЕ (`serve`) тем же ядром, что и настоящий
   * (`allocPassive`); ответ идёт после сейва, как у сервера. `click` — клик по кругу узла в окне, нарисованном по сейву сейчас.
   */
  function setup() {
    const save: SaveState = newBotSave(reg, 'warrior');
    const entry = tree.entryNodes[0]!;
    save.masteries[entry] = 1;
    save.gold = 1_000_000;
    save.unspentMasteryPoints = 10;
    const node = tree.nodes.find((n) => neighborsOf(tree, entry).includes(n.id) && n.maxRank >= 2 && n.cost.type === 'gold')!;
    const sent: TownCommand[] = [];
    const logs: string[] = [];
    const queue: { c: TownCommand; answer: (r: CmdReply | null) => void }[] = [];
    const app = {
      config: reg, state: { save },
      sendCmd(c: TownCommand) { sent.push(c); return sent.length; },
      request(c: TownCommand): Promise<CmdReply | null> {
        this.sendCmd(c);
        return new Promise((answer) => { queue.push({ c, answer }); });
      },
      bus: { emit: (_t: string, e: { text?: string }) => { if (e?.text) logs.push(e.text); } },
    };
    const results: { ok: boolean; reason?: string }[] = [];
    /** Сервер обработал всё, что пришло: сейв меняется ядром, ответ — после. */
    const serve = async (): Promise<void> => {
      for (const { c, answer } of queue.splice(0)) {
        const r = c.cmd === 'allocPassive' ? allocPassive(reg, save, c.nodeId, c.maxGold) : { ok: false, reason: 'n/a' };
        results.push(r);
        answer({ t: 'cmdResult', id: 0, cmd: c.cmd, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
      }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    /** Связь оборвалась: ждущие получают «неизвестно» (`replies.dropAll`). */
    const drop = async (): Promise<void> => {
      for (const { answer } of queue.splice(0)) answer(null);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    const click = (): void => {
      const body = new El('div');
      renderPassiveTree(app as unknown as App, body as unknown as HTMLElement);
      const circle = body.all().find((e) => e.tag === 'circle' && e.attrs.cx === String(node.x) && e.attrs.cy === String(node.y))!;
      circle.click();
    };
    return { save, node, sent, logs, results, serve, drop, click, app };
  }

  it('⭐ два клика быстрее ответа — одна команда; ответ пришёл — следующий клик с ценой следующего ранга, без отказа', async () => {
    const s = setup();
    s.click();
    s.click();                                          // двойной клик — окно ещё по старому сейву
    const allocs = (): TownCommand[] => s.sent.filter((c) => c.cmd === 'allocPassive');
    expect(allocs(), 'было: две команды с ценой ранга 0').toHaveLength(1);
    await s.serve();
    expect(s.results.every((r) => r.ok), JSON.stringify(s.results)).toBe(true);
    expect(s.save.masteries[s.node.id]).toBe(1);
    expect(s.results.some((r) => r.reason?.startsWith(PRICE_CHANGED))).toBe(false);

    s.click();                                          // ответ пришёл — окно по новому сейву
    expect(allocs()).toHaveLength(2);
    expect(allocs()[1]).toEqual({ cmd: 'allocPassive', nodeId: s.node.id, maxGold: passiveNodeCost(s.node.cost.amount, 1, mult) });
    await s.serve();
    expect(s.save.masteries[s.node.id]).toBe(2);
    expect(s.results.every((r) => r.ok)).toBe(true);
  });

  it('отказ сервера — строкой в лог, и узел снова кликается; без ответа (обрыв) — тоже', async () => {
    const s = setup();
    s.save.unspentMasteryPoints = 0;                    // нечем платить — сервер откажет
    s.click();
    await s.serve();
    expect(s.logs, 'ждущему окну отказ App в лог не пишет — пишет само окно').toEqual([expect.stringMatching(/^Не вышло: /)]);
    s.click();
    expect(s.sent.filter((c) => c.cmd === 'allocPassive')).toHaveLength(2);
    await s.drop();
    s.click();
    expect(s.sent.filter((c) => c.cmd === 'allocPassive'), 'ответа нет — узел не залипает').toHaveLength(3);
  });

  it('другой узел не ждёт: цена каждого — от его собственного ранга', () => {
    const s = setup();
    const other = tree.nodes.find((n) => n.id !== s.node.id && neighborsOf(tree, tree.entryNodes[0]!).includes(n.id) && n.cost.type === 'gold')!;
    s.click();
    const body = new El('div');
    renderPassiveTree(s.app as unknown as App, body as unknown as HTMLElement);
    body.all().find((e) => e.tag === 'circle' && e.attrs.cx === String(other.x) && e.attrs.cy === String(other.y))!.click();
    expect(s.sent.map((c) => (c as { nodeId?: string }).nodeId)).toEqual([s.node.id, other.id]);
  });
});
