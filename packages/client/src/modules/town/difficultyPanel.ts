import { effectiveLevel, startChallenge, isDifficultyUnlocked } from '@dm/shared';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { COLORS, mk, button } from '../../ui/kit.js';

/**
 * Алтарь забега у портала (v2). Игрок тюнит забег ПЕРЕД спуском: биом (павшая империя),
 * шаблон (длина/ветвление/боссы), run-модификаторы (реликвии/невзгоды), и тир сложности.
 * «Войти» шлёт серверу `descend` с выбранным тиром + `runConfig` (биом/шаблон/модификаторы) —
 * сервер валидирует (только включённый контент) и запускает голосование → генерацию RunPlan.
 */
export const difficultyPanel: PanelFactory = (app, ui) => {
  let selBiome: string | undefined;
  let selTpl: string | undefined;
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

  function draw(body: HTMLElement): void {
    const state = app.state!;
    const diffs = app.config.get('difficulties');
    const pw = effectiveLevel(state.save, app.config.get('balance').power);
    const biomes = app.config.get('biomes').filter((b) => b.enabled !== false);
    const templates = app.config.get('run-templates').filter((t) => t.enabled !== false);
    const runMods = app.config.get('run-modifiers');

    // Дефолты/санитизация выбора (первый включённый, если текущий пропал из конфига).
    if (biomes.length && !biomes.some((b) => b.id === selBiome)) selBiome = biomes[0]!.id;
    if (templates.length && !templates.some((t) => t.id === selTpl)) selTpl = templates[0]!.id;

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

    // ── Шаблон забега ──
    if (templates.length) {
      body.append(sectionLabel('Шаблон забега'));
      const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
      for (const t of templates) {
        const title = `слоёв ${t.length.min}–${t.length.max} · ширина до ${t.width.max} · босс каждые ${t.bossEvery || '—'}`;
        row.append(chip(t.name, t.id === selTpl, () => { selTpl = t.id; redraw(); }, title));
      }
      body.append(row);
    }

    // ── Run-модификаторы (реликвии/невзгоды) ──
    const tpl = templates.find((t) => t.id === selTpl);
    const allowed = tpl?.allowedModifiers ?? [];
    const mods = runMods.filter((m) => m.enabled !== false && m.scope === 'run' && (allowed.length === 0 || allowed.includes(m.id)));
    if (mods.length) {
      body.append(sectionLabel('Модификаторы'));
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
      const startCL = startChallenge(pw.total, diff);
      const card = mk('div',
        `border:1px solid ${COLORS.border};border-radius:8px;padding:10px 12px;background:${COLORS.panel2}` +
        (unlocked ? '' : ';opacity:0.55'));
      const top = mk('div', 'display:flex;justify-content:space-between;align-items:baseline;gap:10px');
      top.append(mk('b', 'font-size:15px', diff.name));
      top.append(mk('span', `font-size:11px;color:${COLORS.dim}`,
        `золото ×${diff.goldMult} · лут ${diff.ilvlBonus >= 0 ? '+' : ''}${diff.ilvlBonus} · редкость ×${diff.magicFind}`));
      card.append(top);
      card.append(mk('div', 'font-size:12px;color:#c4bca8;margin:4px 0',
        `Монстры на 1-м этаже ≈ ур. ${startCL}, глубже — сложнее.`));
      if (unlocked) {
        card.append(button('Войти', () => {
          ui.close('difficulty');
          app.net.send({ t: 'descend', difficultyId: diff.id, runConfig: { biomeId: selBiome, templateId: selTpl, modifiers: [...selMods] } });
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
