import { effectiveLevel, carriedGear, floorMonsterLevel, isDifficultyUnlocked, altarModifiers, liveModStats, openWaypoints, WAYPOINT_ENTRY_DEPTH } from '@dm/shared';
import { altarChainView, BOSS_RANK_MARK, type AltarChainView } from './altarMapLayout.js';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { COLORS, mk, button } from '../../ui/kit.js';

/**
 * Алтарь забега у портала (v2). Игрок тюнит забег ПЕРЕД спуском: биом (павшая империя),
 * шаблон (ветвление/боссы), run-модификаторы (реликвии/невзгоды), тир сложности и СТАРТОВУЮ МЕТКУ.
 * «Войти» шлёт серверу `descend` с выбранным тиром + `runConfig` (биом/модификаторы) + `startDepth` —
 * сервер валидирует (только включённый контент) и запускает голосование → генерацию RunPlan.
 *
 * ⭐⭐ 14.10 (Г3, В6): МЕТКИ СЧИТАЮТ ТЕ ЖЕ ЧИСТЫЕ ФУНКЦИИ, ЧТО И СЕРВЕР (`openWaypoints` по рекорду тира +
 * `balance.dungeonAccess.waypointStep`; уровень монстров метки — `floorMonsterLevel`, Г1: одна глубина). Своя
 * арифметика показала бы метку, которой сервер не даст, — худший вид расхождения: игрок видит обещание и попадает
 * не туда, куда выбрал. Число из кадра сервер всё равно лишь ЗАЖИМАЕТ сверху (`waypointStart`), поэтому «врать» ему
 * бесполезно, а вот обещать игроку лишнее — вредно.
 *
 * ⭐⭐ Г8-3 (15.10, просьба владельца): ВМЕСТО СПИСКА ЧИПОВ — КАРТА КРУГА. «Добавим карту с порталами эту, чтобы на
 * алтаре можно было выбирать, откуда начать, если открыто несколько.» Раскладка — чистая функция
 * (`altarMapLayout.altarCycleView`), панель только рисует клетки и вешает клик на ОТКРЫТЫЙ портал. Карта отвечает на
 * второй вопрос, которого у чипов не было: что лежит МЕЖДУ метками — где боссы лестницы и какой у этажа уровень.
 *
 * ⚠ В ПАТИ СТАРТ ЗАЖИМАЕТСЯ ПО САМОМУ МЕЛКОМУ РЕКОРДУ (В3), а рекордов напарников клиент НЕ ЗНАЕТ (`PeerInfo` их не
 * несёт). Поэтому список здесь — «по ВАШЕМУ рекорду», и это сказано словами, а точную глубину называет окно
 * голосования (`voteStart.startDepth` → `ui/voteText.ts`): там она уже зажата сервером, то есть «окно ≡ исход».
 */
export const difficultyPanel: PanelFactory = (app, ui) => {
  let selBiome: string | undefined;
  /** Выбранная стартовая метка (глубина). Умолчание — вход в спуск: он открыт всегда, даже без рекорда. */
  let selDepth: number = WAYPOINT_ENTRY_DEPTH;
  /** ⭐ Г8-3: масштаб цепи меток (ручка «приблизить»); живёт, пока окно открыто. */
  let selZoom = 1;
  const selMods = new Set<string>();
  let bodyRef: HTMLElement | undefined;
  const redraw = (): void => { if (bodyRef) { bodyRef.innerHTML = ''; draw(bodyRef); } };

  const sectionLabel = (t: string): HTMLElement =>
    mk('div', `font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:${COLORS.dim};margin:10px 0 5px`, t);

  const chip = (label: string, active: boolean, onClick: () => void, title?: string): HTMLElement => {
    const c = mk('button',
      `padding:4px 11px;border-radius:14px;cursor:pointer;font-size:12px;` +
      `border:1px solid ${active ? COLORS.gold : COLORS.border};` +
      `background:${active ? 'rgba(220,169,75,0.16)' : COLORS.panel2};` +
      `color:${active ? COLORS.gold : '#c4bca8'}`, label);
    if (title) c.title = title;
    c.onclick = onClick;
    return c;
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Элемент SVG с атрибутами — `mk` не годится: у SVG своё пространство имён, иначе браузер не рисует ничего. */
  const svg = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const e = document.createElementNS(SVG_NS, tag) as SVGElement;
    for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  /** Тултип SVG-элемента — `<title>` внутри него (атрибут `title` в SVG не работает). */
  const svgTitle = (host: SVGElement, text: string): void => { host.append(svg('title', {}, text)); };

  /**
   * ⭐⭐ Г8-3: ЦЕПЬ МЕТОК. Вид решает модель (`altarChainView`) — здесь только краски, клик и зум.
   *  • узел — открытая метка: золотая рамка, курсор-палец, клик выбирает старт (закрытых в списке сервера нет);
   *  • звено — жилы по точкам модели: несущая толще, развилки тоньше (на звене с боссом жила одна);
   *  • босс — табличка со знаком ранга и номером его этажа прямо на звене;
   *  • разделитель круга — пунктир с подписью: круги читаются, а цепь остаётся ОДНОЙ.
   */
  const chainSvg = (view: AltarChainView, zoom: number, onPick: (d: number) => void): SVGElement => {
    const root = svg('svg', {
      viewBox: `0 0 ${view.width} ${view.height}`,
      width: Math.round(view.width * zoom), height: Math.round(view.height * zoom),
      style: 'display:block',
    });
    for (const d of view.dividers) {
      root.append(svg('line', { x1: 8, y1: d.y, x2: view.width - 8, y2: d.y, stroke: '#242a35', 'stroke-dasharray': '4 4' }));
      root.append(svg('text', { x: 10, y: d.y - 5, 'font-size': 9, fill: '#5d5a54' }, d.label));
    }
    for (const link of view.links) {
      for (const s of link.strands) {
        root.append(svg('polyline', {
          points: s.points.map((p) => `${p.x},${p.y}`).join(' '),
          fill: 'none', stroke: s.main ? '#6a5a28' : '#413a26',
          'stroke-width': s.main ? 2 : 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }));
      }
      if (link.boss) {
        const g = svg('g', {});
        g.append(svg('rect', { x: link.boss.x - 17, y: link.boss.y - 10, width: 34, height: 20, rx: 5, fill: '#2a1414', stroke: '#6b3a34' }));
        g.append(svg('text', { x: link.boss.x, y: link.boss.y + 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#e0a090' }, link.boss.mark));
        g.append(svg('text', { x: link.boss.x + 24, y: link.boss.y + 4, 'font-size': 9, fill: '#8a7a74' }, String(link.boss.depth)));
        svgTitle(g, link.boss.title);
        root.append(g);
      } else if (link.gap) {
        root.append(svg('text', { x: link.gap.x, y: link.gap.y + 3, 'font-size': 9, fill: '#55524c' }, link.gap.text));
      }
    }
    for (const n of view.nodes) {
      const g = svg('g', { style: n.open ? 'cursor:pointer' : '' });
      if (n.pick) g.append(svg('circle', { cx: n.x, cy: n.y, r: view.r + 5, fill: 'none', stroke: COLORS.gold, 'stroke-width': 1, opacity: 0.45 }));
      g.append(svg('circle', {
        cx: n.x, cy: n.y, r: view.r,
        fill: n.pick ? '#2a2214' : n.open ? '#191610' : '#0d0d12',
        stroke: n.open ? COLORS.gold : '#4a4640', 'stroke-width': n.pick ? 2 : 1,
      }));
      g.append(svg('text', { x: n.x, y: n.y - 3, 'text-anchor': 'middle', 'font-size': 9, fill: n.open ? COLORS.gold : '#5d5a54' }, '⌂'));
      g.append(svg('text', { x: n.x, y: n.y + 8, 'text-anchor': 'middle', 'font-size': 10, fill: n.open ? '#e6ddc9' : '#5d5a54' }, n.label));
      if (n.entry) root.append(svg('text', { x: n.x + view.r + 6, y: n.y + 4, 'font-size': 9, fill: COLORS.dim }, 'вход'));
      svgTitle(g, n.title);
      if (n.open) g.addEventListener('click', () => onPick(n.depth));
      root.append(g);
    }
    return root;
  };

  function draw(body: HTMLElement): void {
    const state = app.state!;
    const diffs = app.config.get('difficulties');
    const pw = effectiveLevel(state.save, app.config.get('balance').power, carriedGear(state.save), app.config.get('item-tiers'));   // R8-10, R12-09: как меряет сервер — с запасом и ступенью
    const biomes = app.config.get('biomes').filter((b) => b.enabled !== false);
    const runMods = app.config.get('run-modifiers');
    // Каденция привала — одно число баланса на всю игру (Г2, Р4): и подпись шаблона, и список меток ниже.
    const access = app.config.get('balance').dungeonAccess;
    const portalsAt = access.portalsAt;
    // ⭐⭐ Г8-2: метка — место в ПОЛОСЕ цикла (схема владельца 15.10), поэтому список меток считается с циклом —
    // тем же числом, которым сервер считает разрешённый старт (`Room.startDepthOf`).
    const contentCycle = access.contentCycle;

    // Дефолты/санитизация выбора (первый включённый, если текущий пропал из конфига).
    if (biomes.length && !biomes.some((b) => b.id === selBiome)) selBiome = biomes[0]!.id;

    const head = mk('div', 'margin-bottom:4px;font-size:13px;min-width:360px');
    head.innerHTML =
      `Мощь персонажа: <b style="color:${COLORS.gold}">${pw.total}</b> ` +
      `<span style="color:${COLORS.dim}">(ур. ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus})</span>`;
    body.append(head);

    // ── PvP-арена ── круглый зал: игроки бьются друг с другом, без штрафа смерти.
    const pvpRow = mk('div', 'margin:6px 0 2px');
    pvpRow.append(button('⚔ PvP-арена (дуэль на алтаре)', () => {
      ui.close('difficulty');
      app.net.send({ t: 'arena' });
    }, 'danger'));
    body.append(pvpRow);
    body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:2px;font-style:italic`,
      'Круглый зал: спавн в разных концах, урон по друг другу, гибель без потерь.'));

    // ── Биом ──
    if (biomes.length) {
      body.append(sectionLabel('Биом (павшая империя)'));
      const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
      for (const b of biomes) row.append(chip(b.name, b.id === selBiome, () => { selBiome = b.id; redraw(); }, b.tagline || b.desc || undefined));
      body.append(row);
      const cur = biomes.find((b) => b.id === selBiome);
      if (cur?.tagline || cur?.desc) body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:4px;font-style:italic`, cur.tagline || cur.desc));
    }

    // ── Шаблон забега: СНЯТ ОКОНЧАТЕЛЬНО (Г8-4 → Ф1) ──
    // ⭐⭐ 15.10, решение владельца: «Короткая вылазка / Стандартный забег / Глубокая экспедиция — это да убираем,
    // больше нам это не нужно». Их имена обещали ДЛИНУ, которой с бесконечным спуском нет, а главное — шаблон мог
    // молча отменить контент круга: у «Короткой вылазки» стоял `bosses: false`, а боссовый этаж крипты в неё даже
    // не входил, и боссы лестницы пропадали целиком. Теперь забег ОДИН, его ручки (ширина слоя, ветвистость, веса
    // типов рядовых узлов, список модификаторов) живут в конфиг-редакторе, а метки и боссы решает только таблица
    // круга. ⚠ Ф1 (16.10): последняя строка шаблона РАСТВОРЕНА в `balance.dungeonAccess` — форма забега (ширина
    // слоя, ветвистость, веса типов, список модификаторов алтаря) стала одной настройкой игры, а `templateId`
    // ушёл с провода: кадр `descend` его больше не несёт, и сервер его не ждёт.

    // ── Run-модификаторы (реликвии/невзгоды) ──
    // ⚠ R8-12: только ДЕЙСТВУЮЩИЕ (`altarModifiers` — тот же отбор, что у сервера): эффекты модификаторов игра пока не
    // применяет, и алтарь обещал «+10% здоровья» за ничто. Нет действующих — секции нет.
    const mods = altarModifiers(runMods, access.allowedModifiers, liveModStats(app.config));
    for (const id of [...selMods]) if (!mods.some((m) => m.id === id)) selMods.delete(id);   // выбор под прежний шаблон
    if (mods.length) {
      body.append(sectionLabel('Модификаторы'));
      body.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px;font-style:italic`,
        'Благо — только в паре с опасностью: лишние блага алтарь отбросит.'));
      const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
      for (const m of mods) {
        row.append(chip(m.name, selMods.has(m.id), () => { if (selMods.has(m.id)) selMods.delete(m.id); else selMods.add(m.id); redraw(); }, m.desc || undefined));
      }
      body.append(row);
    }

    // ── Тир сложности + вход ──
    body.append(sectionLabel('Сложность (тир) — жмите «Войти»'));
    const list = mk('div', 'display:flex;flex-direction:column;gap:8px;min-width:360px');
    diffs.forEach((diff, i) => {
      if (diff.enabled === false) return; // выключенный тир не предлагаем (индекс i сохраняем — цепочка разблокировки цела)
      const unlocked = isDifficultyUnlocked(diffs, i, state.save.difficultyProgress);
      const startCL = floorMonsterLevel(diff, 1);   // ⭐ 13.10 (Г1): 1-й этаж тира, от глубины — мощь героя монстров не двигает
      const card = mk('div',
        `border:1px solid ${COLORS.border};border-radius:8px;padding:10px 12px;background:${COLORS.panel2}` +
        (unlocked ? '' : ';opacity:0.55'));
      const top = mk('div', 'display:flex;justify-content:space-between;align-items:baseline;gap:10px');
      top.append(mk('b', 'font-size:15px', diff.name));
      top.append(mk('span', `font-size:11px;color:${COLORS.dim}`,
        // ⚠ Строки «лут +N» больше нет: сложность не прибавляется к уровню вещи напрямую.
        // Она поднимает уровень МОНСТРОВ, а дроп подтягивается оттуда — и это видно строкой ниже.
        `золото ×${diff.goldMult} · редкость ×${diff.magicFind}`));
      card.append(top);
      card.append(mk('div', 'font-size:12px;color:#c4bca8;margin:4px 0',
        `Монстры на 1-м этаже — ур. ${startCL}, глубже — сложнее.`));
      if (unlocked) {
        // ⭐ Г3 (В6): открытые метки ЭТОГО тира — рекорд тира у каждого свой, поэтому список живёт в карточке тира.
        const marks = openWaypoints(state.save.difficultyProgress, diff.id, portalsAt, contentCycle);
        const pick = marks.includes(selDepth) ? selDepth : WAYPOINT_ENTRY_DEPTH;   // выбор от другого тира не переносим
        card.append(mk('div', `font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:${COLORS.dim};margin:8px 0 4px`, 'Старт — открытая метка'));
        // ⭐⭐ Г8-3: КАРТА КРУГА вместо плоского списка чипов. Уровень монстров этажа остаётся в тултипе каждой
        // клетки, а выбранный старт — строкой под картой: в клетке 30×26 он не читается, а соврать им нельзя.
        // ⚠ Потолок ветвления берётся у ВЫБРАННОГО шаблона: цепь не имеет права обещать развилок больше, чем
        // шаблон разрешает (шаблон шириной 1 — прямая цепь без ветвления).
        const widthMax = access.width.max;
        const view = altarChainView(marks, state.save.difficultyProgress[diff.id] ?? 0, portalsAt, contentCycle,
          access.bossLadder, pick, (d) => floorMonsterLevel(diff, d), widthMax);
        // ⭐⭐ Г8-3: СКРЫТЫЕ ЦЕПЬЮ МЕТКИ НЕ ТЕРЯЮТСЯ. Цепь показывает последние метки; всё, что выше, остаётся
        // доступным компактным рядом — иначе карта отобрала бы у глубокого героя старты, которые плоский список
        // чипов давал (замер: рекорд 300 — открытых меток 106, в цепи 48).
        if (view.hiddenMarks.length) {
          card.append(mk('div', `font-size:10px;color:${COLORS.dim};font-style:italic;margin-bottom:3px`, view.hidden ?? ''));
          const row = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;max-height:52px;overflow:auto;margin-bottom:4px');
          for (const d of view.hiddenMarks) {
            // ⚠ Тултип — ТОТ ЖЕ, что у узла цепи: одна вещь (место старта) обязана называться одинаково,
            // иначе игрок (и сторож) читает два разных обещания про одно и то же.
            row.append(chip(`${d}`, d === pick, () => { selDepth = d; redraw(); },
              `Портал — этаж ${d}, монстры ур. ${floorMonsterLevel(diff, d)}. Можно начать отсюда.`));
          }
          card.append(row);
        }
        // ⭐ ЗУМ — ручка игрока («чтобы можно было приблизить»), живёт между перерисовками в `selZoom`.
        const zoomRow = mk('div', 'display:flex;align-items:center;gap:6px;margin-bottom:4px');
        zoomRow.append(mk('span', `font-size:10px;color:${COLORS.dim}`, 'приблизить'));
        const zoomIn = mk('input', 'flex:1;max-width:120px;accent-color:#dca94b') as HTMLInputElement;
        zoomIn.type = 'range'; zoomIn.min = '60'; zoomIn.max = '180'; zoomIn.step = '5';
        zoomIn.value = String(Math.round(selZoom * 100));
        zoomIn.title = 'Масштаб цепи меток';
        zoomRow.append(zoomIn);
        card.append(zoomRow);
        // Скрол ВЕРТИКАЛЬНЫЙ: спуск идёт вниз, и карта листается так же.
        const scroll = mk('div', `max-height:300px;overflow-y:auto;overflow-x:auto;border:1px solid ${COLORS.border};border-radius:6px;background:#0b0e14`);
        scroll.append(chainSvg(view, selZoom, (d) => { selDepth = d; redraw(); }));
        card.append(scroll);
        // ⚠ Зум перерисовывает ТОЛЬКО цепь, а не всю панель: перерисовка панели сбросила бы прокрутку окна
        // и ползунок потерял бы захват мышью на первом же шаге.
        zoomIn.addEventListener('input', () => {
          selZoom = Math.max(0.6, Math.min(1.8, (Number(zoomIn.value) || 100) / 100));
          scroll.innerHTML = '';
          scroll.append(chainSvg(view, selZoom, (d) => { selDepth = d; redraw(); }));
        });
        card.append(mk('div', 'font-size:12px;color:#c4bca8;margin:5px 0', view.start));
        card.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:5px;font-style:italic`,
          `⌂ — портал (отсюда можно начать), ${BOSS_RANK_MARK.mini}/${BOSS_RANK_MARK.strong}/${BOSS_RANK_MARK.act} — мини/крепкий/актовый босс между метками, ветки — развилки этажей. Открыты метки не глубже ВАШЕГО рекорда (${view.record}). В пати старт зажимается по самому мелкому рекорду — точную глубину назовёт окно голосования.`));
        card.append(button('Войти', () => {
          ui.close('difficulty');
          app.net.send({ t: 'descend', difficultyId: diff.id, startDepth: pick, runConfig: { biomeId: selBiome, modifiers: [...selMods] } });
        }, i >= 2 ? 'danger' : 'primary'));
      } else {
        const prev = diffs[i - 1];
        const have = state.save.difficultyProgress[prev?.id ?? ''] ?? 0;
        card.append(mk('div', 'font-size:11px;color:#d0a060',
          `🔒 Пройди этаж ${diff.unlockFloor} на «${prev?.name ?? '—'}» (сейчас ${have})`));
      }
      list.append(card);
    });
    body.append(list);
  }

  const panel: Panel = { title: 'Алтарь забега', render(body) { bodyRef = body; draw(body); } };
  return panel;
};
