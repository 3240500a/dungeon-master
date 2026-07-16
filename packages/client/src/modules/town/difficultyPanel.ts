import { effectiveLevel, startChallenge, isDifficultyUnlocked } from '@dm/shared';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { COLORS, mk, button } from '../../ui/kit.js';

/**
 * Экран выбора сложности у портала. Показывает «мощь» персонажа, а для каждого
 * тира — стартовый уровень монстров и множители награды; заблокированные тиры
 * недоступны (прогрессивная разблокировка по глубине). Выбор шлёт серверу `descend`
 * с выбранной сложностью — сервер валидирует разблокировку и запускает голосование.
 */
export const difficultyPanel: PanelFactory = (app, ui) => {
  const panel: Panel = {
    title: 'Спуск в подземелье',
    render(body) {
      const state = app.state!;
      const diffs = app.config.get('difficulties');
      const pw = effectiveLevel(state.save, app.config.get('balance').power);

      const head = mk('div', 'margin-bottom:12px;font-size:13px');
      head.innerHTML =
        `Мощь персонажа: <b style="color:${COLORS.gold}">${pw.total}</b> ` +
        `<span style="color:${COLORS.dim}">(ур. ${pw.level} + гир +${pw.gearBonus} + мастерства +${pw.passiveBonus})</span><br>` +
        `<span style="color:${COLORS.dim}">Чем выше сложность, тем сильнее монстры и жирнее награда.</span>`;
      body.append(head);

      const list = mk('div', 'display:flex;flex-direction:column;gap:8px;min-width:340px');
      diffs.forEach((diff, i) => {
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
          const enter = button('Войти', () => {
            ui.close('difficulty');
            app.net.send({ t: 'descend', difficultyId: diff.id });
          }, i >= 2 ? 'danger' : 'primary');
          card.append(enter);
        } else {
          const prev = diffs[i - 1];
          const have = state.save.difficultyProgress[prev?.id ?? ''] ?? 0;
          card.append(mk('div', 'font-size:11px;color:#d0a060',
            `🔒 Пройди этаж ${diff.unlockFloor} на «${prev?.name ?? '—'}» (сейчас ${have})`));
        }
        list.append(card);
      });
      body.append(list);
    },
  };
  return panel;
};
