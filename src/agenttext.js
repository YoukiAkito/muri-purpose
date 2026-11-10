/**
 * 从 agent 的事件流里捡它说过的话。
 *
 * 子会话干完活之后，结果只留在它自己的会话事件里——没有返回值、
 * 没有回调，只能回过头去翻它写了什么。所以这里做两件事：
 *   1. 拿到事件数组（live 的和 resum 回来的取法不同）
 *   2. 只挑 assistant 的 text 块拼起来
 *
 * 工具调用、思考过程都丢掉：要的是它最后写给人看的那段话。
 */

function asObject(value) {
  return value !== null && typeof value === 'object' ? value : undefined;
}

/** 从 session 对象上取事件数组；取不到返回空数组。 */
export function eventsOf(agent) {
  const session = asObject(agent?.session);
  if (session === undefined) return [];
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === 'function') {
    try {
      const rows = session.snapshotEvents();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  return [];
}

function textOfContent(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const parts = [];
  for (const block of value) {
    const item = asObject(block);
    if (item !== undefined && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

/**
 * 拿最后一条 assistant 正文。
 *
 * 找最后一个有文字的 assistant/message 往回退——回合结束时往往还有一条
 * 空正文（纯工具调用收尾），直接取最后一条会拿到空串。
 */
export function lastAssistantText(events) {
  const rows = Array.isArray(events) ? events : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = asObject(rows[index]);
    if (row === undefined || row.type !== 'assistant/message') continue;
    const data = asObject(row.data) ?? {};
    const message = asObject(data.message) ?? data;
    const text = textOfContent(message.content);
    if (text !== '') return text;
  }
  return '';
}

/** 从 agent 直接取最后一条正文。 */
export function lastAssistantTextOf(agent) {
  return lastAssistantText(eventsOf(agent));
}

/** 数一下转了几轮（assistant 消息条数），用来看这次是不是白跑了。 */
export function countAssistantTurns(events) {
  return (Array.isArray(events) ? events : []).filter((row) => asObject(row)?.type === 'assistant/message').length;
}
