import type { QuestDef, QuestProgress } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { PanelFactory } from '../../ui/domUi.js';
import { button } from '../../ui/kit.js';

/**
 * Журнал квестов (клавиша J) — ЧИСТЫЙ ВЬЮ. Активные/к сдаче читаются из авторитетного
 * `save.quests`+`save.activeQuestDefs`, доска случайных — из `app.questBoard` (кадр сервера).
 * Действия «Взять»/«Забрать награду» шлют команды `acceptQuest`/`turnInQuest` — весь трекинг
 * и награды считает сервер (см. shared `questLogic` + серверный `Room`).
 */
function questBlock(def: QuestDef, prog: QuestProgress | undefined): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'border:1px solid #2c2c3a;border-radius:6px;padding:8px;margin:6px 0;background:#161620';
  const status =
    prog?.status === 'completed'
      ? '<span style="color:#7fd67f">выполнено</span>'
      : prog?.status === 'turned-in'
        ? '<span style="color:#888">сдано</span>'
        : '';
  el.innerHTML = `<div style="display:flex;justify-content:space-between">
      <b>${def.name}</b><span style="font-size:12px">${status}</span></div>
    <div style="font-size:12px;color:#b8b8c8;margin:2px 0 6px">${def.description}</div>`;
  for (const obj of def.objectives) {
    const cur = prog?.counters[obj.id] ?? 0;
    const line = document.createElement('div');
    line.style.cssText = 'font-size:12px;color:#9aa';
    line.textContent = `• ${obj.type}${obj.target ? ` ${obj.target}` : ''}: ${cur}/${obj.amount}`;
    el.appendChild(line);
  }
  const r = def.reward;
  const reward = [r.gold && `${r.gold} зол.`, r.xp && `~${Math.round(r.xp / 10)}% ур. опыта`, r.skillPoints && `${r.skillPoints} очк.`, r.itemBaseId && 'предмет']
    .filter(Boolean)
    .join(', ');
  el.insertAdjacentHTML('beforeend', `<div style="font-size:11px;color:#ffd24b;margin-top:4px">Награда: ${reward}</div>`);
  return el;
}

export const questLogPanel: PanelFactory = (app: App) => ({
  title: 'Журнал квестов',
  render(body) {
    const state = app.state!;

    const active = state.save.quests.filter((q) => q.status !== 'turned-in');
    const h1 = document.createElement('h4');
    h1.textContent = 'Активные';
    h1.style.margin = '0 0 6px';
    body.appendChild(h1);
    if (active.length === 0) body.insertAdjacentHTML('beforeend', '<div style="color:#666">Нет активных квестов</div>');
    for (const prog of active) {
      const def = state.save.activeQuestDefs.find((d) => d.id === prog.questId);
      if (!def) continue;
      const block = questBlock(def, prog);
      if (prog.status === 'completed') {
        const btn = button('Забрать награду', () => app.sendCmd({ cmd: 'turnInQuest', questId: def.id }), 'primary');
        btn.style.marginTop = '6px';
        block.appendChild(btn);
      }
      body.appendChild(block);
    }

    const h2 = document.createElement('h4');
    h2.textContent = 'Доска заданий (случайные)';
    h2.style.margin = '16px 0 6px';
    body.appendChild(h2);
    if (app.questBoard.length === 0) {
      body.insertAdjacentHTML('beforeend', '<div style="color:#666">Доска пуста. Загляните позже.</div>');
    }
    for (const def of app.questBoard) {
      const block = questBlock(def, undefined);
      const btn = button('Взять', () => app.sendCmd({ cmd: 'acceptQuest', questId: def.id }));
      btn.style.marginTop = '6px';
      block.appendChild(btn);
      body.appendChild(block);
    }
  },
});
