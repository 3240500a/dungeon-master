import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runVoteQuestion, type RunVoteCfg, type RunVoteFrame } from './runVote.js';
import { runDeathDock, runDeathFrame, runDeathOnFrame, runDeathView, type RunDeathState, type RunDeathView, type RunDiedFrame } from './runDeath.js';
import { RUN_MAP_GEOM, runMapLegend, runMapPanelView } from './runMap.js';
import { runSpectateFrame, runSpectateTab, type RunSpectPlayer } from './runSpectate.js';
import { richEsc } from './runCommon.js';
import type { RunPlan } from '../dungeon/run/types.js';

/**
 * ⭐⭐ С-views (29.10): ВИДЫ ЗАБЕГА ПРОТИВ ЭТАЛОНА ОКОН UNITY (`unity_run_ui.json`, разделы `vote`, `death`, `runMap`, `spectate`).
 *
 * Сверка — ТА ЖЕ, что делает `RunUiCheck` Unity над своими портами: вопрос — видимый текст без тегов rich text (с «‹›» вместо
 * «<>»), жирные куски и цвет предупреждения; смерть — окно/спрятано/плашка/состояние по шагам; карта — шапка, размер, узлы,
 * полоса этажей, рёбра; наблюдение — фокус, подпись, Tab. Разделы `camera` и `wallFade` — отрисовка, их здесь нет намеренно.
 *
 * ⭐ С11 (29.10): эталон ЗАМОРОЖЕН здесь (`__fixtures__/unity_run_ui.json`, выход веб-окон на теге `web-client-final`): веб-клиента и портов
 * Unity больше нет, вид сервера — сам источник; файл держит прежнее поведение окон как регрессию. Нет файла — сторож пропускается.
 */

const CANDIDATES = [
  './__fixtures__/unity_run_ui.json',
];
const goldenPath = CANDIDATES.map((rel) => fileURLToPath(new URL(rel, import.meta.url))).find((p) => existsSync(p));
const g = goldenPath ? JSON.parse(readFileSync(goldenPath, 'utf8')) as Golden : null;

interface Golden {
  vote: { cfgs: Record<string, RunVoteCfg>; cases: { cfg: string; frame: RunVoteFrame; progress: Record<string, number> | null; plain: string; bold: string[]; warnColor: string | null }[] };
  death: { labels: { wait: string; spectate: string }; seqs: { name: string; steps: ({ died: RunDiedFrame } | { dismiss: true } | { reset: true })[]; out: DeathOut[] }[] };
  runMap: {
    colW: number; rowH: number; pad: number; r: number; headH: number;
    legend: { type: string; label: string; color: string }[];
    plans: Pick<RunPlan, 'biomeId' | 'tier' | 'nodes'>[];
    cases: { plan: number | null; current: string | null; places: number | number[]; cycle: number; out: MapOut }[];
  };
  spectate: { seqs: { name: string; out: ({ op: 'frame'; players: RunSpectPlayer[]; spectateId: string | null; focus: string | null; hint: string | null }
    | { op: 'tab'; players: RunSpectPlayer[]; spectateId: string | null; used: boolean })[] }[] };
}
interface DeathOut {
  shown: { title: string; loss?: string; status: string; spectate?: string; town?: string } | null;
  hidden: boolean;
  dock: string | null | { status: string; town: string };
  state: { losses: { gold: number; items: number } | null; toTown: boolean; canLeave: boolean; pvp: boolean; wipe: boolean; open: boolean } | null;
}
interface MapOut {
  empty?: string; head: string; width: number; height: number;
  cols: { depth: number; x: number; label: string; current: boolean; waypoint: boolean }[];
  nodes: { id: string; type: string; x: number; y: number; fill: string; stroke: string; strokeWidth: number; fillOpacity: number;
    ring: { r: number; stroke: string; width: number } | null; label: string; labelY: number; labelColor: string; star: boolean; cur: boolean; next: boolean }[];
  edges: { from: string; to: string; stroke: string; width: number; opacity: number }[];
}

const RICH = /<\/?b>|<color=#[0-9a-fA-F]{6}>|<\/color>/g;
const sameView = (v: RunDeathView | null, w: DeathOut['shown']): boolean => (w === null ? v === null
  : v !== null && v.title === w.title && v.loss === (w.loss ?? null) && v.status === w.status && v.spectate === (w.spectate ?? null) && v.town === (w.town ?? null));
const sameState = (s: RunDeathState | null, w: DeathOut['state']): boolean => (w === null ? s === null
  : s !== null && s.hasLosses === (w.losses !== null) && (!s.hasLosses || (s.lossGold === w.losses!.gold && s.lossItems === w.losses!.items))
    && s.toTown === w.toTown && s.canLeave === w.canLeave && s.pvp === w.pvp && s.wipe === w.wipe && s.open === w.open);
const sameDock = (called: boolean, d: { status: string; town: string } | null, w: DeathOut['dock']): boolean => (typeof w === 'string' ? !called
  : w === null ? called && d === null : called && d !== null && d.status === w.status && d.town === w.town);

describe.skipIf(!g)('С-views: виды забега ≡ эталон окон Unity (unity_run_ui.json)', () => {
  it('голосование: текст, жирное, цвет предупреждения — на всех случаях эталона', () => {
    let n = 0;
    for (const c of g!.vote.cases) {
      const q = runVoteQuestion(c.frame, g!.vote.cfgs[c.cfg]!, c.progress);
      const name = `${JSON.stringify(c.frame)} / ${JSON.stringify(c.progress)}`;
      expect(q.replace(RICH, ''), name).toBe(richEsc(c.plain));
      const bolds = [...q.matchAll(/<b>(.*?)<\/b>/gs)].map((m) => m[1]!.replace(RICH, ''));
      expect(bolds, name).toEqual(c.bold.map(richEsc));
      expect(/<b><color=(#[0-9a-fA-F]{6})>/.exec(q)?.[1] ?? null, name).toBe(c.warnColor);
      n++;
    }
    expect(n).toBe(g!.vote.cases.length);
    expect(g!.vote.cases.some((c) => c.warnColor !== null), 'эталон потерял случай закрытого тира').toBe(true);
  });

  it('смерть: порт C# DeathFlow и разделение «сервер шлёт view/dock/opens, клиент хранит open» — оба шаг в шаг', () => {
    expect(g!.death.labels).toEqual({ wait: 'Ожидайте: пати спустится — там возродитесь.', spectate: 'Смотреть' });
    for (const seq of g!.death.seqs) {
      // (а) прямой порт C# `DeathFlow` поверх чистых функций
      let s: RunDeathState | null = null;
      // (б) авторитетная схема: сервер держит состояние без `open`, клиент — только `open` и последнюю плашку
      let server: RunDeathState | null = null;
      let open = false;
      let lastDock: ReturnType<typeof runDeathDock> = null;
      seq.steps.forEach((st, i) => {
        const w = seq.out[i]!;
        const name = `«${seq.name}» шаг ${i}`;
        let shownA: RunDeathView | null = null, hiddenA = false, dockA: ReturnType<typeof runDeathDock> = null, calledA = false;
        let shownB: RunDeathView | null = null, hiddenB = false, dockB: ReturnType<typeof runDeathDock> = null, calledB = false;
        if ('died' in st) {
          s = runDeathOnFrame(s, st.died);
          if (s.open) shownA = runDeathView(s);
          dockA = runDeathDock(s); calledA = true;
          const dv = runDeathFrame(server, st.died);
          server = dv.state;
          if (dv.opens) open = true;
          if (open) shownB = dv.view;
          lastDock = dv.dock;
          dockB = open ? null : dv.dock; calledB = true;
        } else if ('dismiss' in st) {
          if (s) s.open = false;
          hiddenA = true; dockA = runDeathDock(s); calledA = true;
          if (server) open = false;
          hiddenB = true; dockB = server && !open ? lastDock : null; calledB = true;
        } else {
          s = null; hiddenA = true; dockA = null; calledA = true;
          server = null; open = false; lastDock = null; hiddenB = true; dockB = null; calledB = true;
        }
        expect(sameView(shownA, w.shown), `${name} — окно (порт)`).toBe(true);
        expect(hiddenA, `${name} — спрятано (порт)`).toBe(w.hidden);
        expect(sameDock(calledA, dockA, w.dock), `${name} — плашка (порт)`).toBe(true);
        expect(sameState(s, w.state), `${name} — состояние (порт)`).toBe(true);
        expect(sameView(shownB, w.shown), `${name} — окно (сервер+open)`).toBe(true);
        expect(hiddenB, `${name} — спрятано (сервер+open)`).toBe(w.hidden);
        expect(sameDock(calledB, dockB, w.dock), `${name} — плашка (сервер+open)`).toBe(true);
        const merged: RunDeathState | null = server ? { ...(server as RunDeathState), open } : null;
        expect(sameState(merged, w.state), `${name} — состояние (сервер+open)`).toBe(true);
      });
    }
  });

  it('карта забега: геометрия, легенда и все случаи эталона (шапка, размер, узлы, полоса этажей, рёбра)', () => {
    const rm = g!.runMap;
    expect({ colW: rm.colW, rowH: rm.rowH, pad: rm.pad, r: rm.r, headH: rm.headH }).toEqual(RUN_MAP_GEOM);
    expect(runMapLegend()).toEqual(rm.legend);
    for (const c of rm.cases) {
      const plan = c.plan === null ? null : rm.plans[c.plan]!;
      const v = runMapPanelView(plan, c.current, c.places, c.cycle);
      const w = c.out;
      const name = `план ${c.plan} текущий ${c.current ?? '—'} места ${JSON.stringify(c.places)} цикл ${c.cycle}`;
      if (w.empty !== undefined) { expect(v.empty, name).toBe(w.empty); continue; }
      expect(v.empty, name).toBeNull();
      expect([v.head, v.width, v.height], name).toEqual([w.head, w.width, w.height]);
      expect(v.nodes.map((u) => [u.id, u.type, u.x, u.y, u.fill, u.cur, u.next, u.stroke, u.strokeWidth, u.fillOpacity, u.label, u.labelY, u.labelColor, u.star]), name)
        .toEqual(w.nodes.map((x) => {
          if (x.ring) expect([x.ring.r, x.ring.width, x.ring.stroke]).toEqual([RUN_MAP_GEOM.r + 6, 3, '#dca94b']);
          return [x.id, x.type, x.x, x.y, x.fill, x.ring !== null, x.next, x.stroke, x.strokeWidth, x.fillOpacity, x.label, x.labelY, x.labelColor, x.star];
        }));
      expect(v.cols, name).toEqual(w.cols.map((x) => ({ depth: x.depth, x: x.x, label: x.label, cur: x.current, waypoint: x.waypoint })));
      expect(v.edges, name).toEqual(w.edges);
    }
    expect(rm.cases.length).toBeGreaterThan(400);
  });

  it('наблюдение: фокус, подпись и Tab по эталонным последовательностям', () => {
    for (const seq of g!.spectate.seqs) {
      let id: string | null = null;
      seq.out.forEach((o, i) => {
        const name = `«${seq.name}» шаг ${i}`;
        if (o.op === 'frame') {
          const r = runSpectateFrame(o.players, 'me', id);
          id = r.spectateId;
          expect([r.spectateId, r.focus, r.hint], name).toEqual([o.spectateId, o.focus, o.hint]);
        } else {
          const r = runSpectateTab(o.players, 'me', id);
          id = r.spectateId;
          expect([r.spectateId, r.used], name).toEqual([o.spectateId, o.used]);
        }
      });
    }
  });
});
