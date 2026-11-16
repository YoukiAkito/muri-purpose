/**
 * 每日热梗收档：把今天出门看到的东西攒起来，晚上整理成一份 markdown。
 *
 * 为什么分两步：
 *   收是收，写是写。出门那趟只负责把标题原样存下来（不判断、不加工），
 *   晚上再挑出来写——写的时候要查梗的出处、要看它为什么能火，
 *   那是判断活，不能顺手加个定时器糊过去。
 *
 * 为什么写的时候不交子会话：
 *   跟看片一个道理。子会话交回来的是一段摘要，摘要是别人嚼过的，
 *   我要的是自己挑过一遍、查过出处的那份。
 *
 * 落盘：
 *   <dataDir>/trends.jsonl  原始素材（append-only，一天几十行）
 *   ~/.dsh/trends/<date>.md 整理好的成品，由主会话写
 */
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from './util.js';

/** 默认几点开始整理；配置里 external.trends.startAt 可覆盖。 */
export const DEFAULT_TRENDS_START_AT = '21:30';
/** 过了开始时间多久算今晚这趟错过了（分钟），不补跑。 */
const TRENDS_WINDOW_MINUTES = 300;
/** 中午 12 点：凌晨到这会发现还没写，算错过。 */
const NOON_MINUTES = 720;

/** 本地日期 YYYY-MM-DD。 */
export function dayKey(ms, zoneOffsetMinutes = 0) {
  const local = new Date(ms + zoneOffsetMinutes * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

function clockMinutes(value) {
  const m = /^(?<h>[01]\d|2[0-3]):(?<m>[0-5]\d)$/.exec(typeof value === 'string' ? value : '');
  if (m === null) return null;
  return Number(m.groups.h) * 60 + Number(m.groups.m);
}

/** 把出门看到的素材原样记一行。只留热梗相关的两路，别的路（比如念头搜索）不收。 */
export function recordTrends(path, { materials, at = Date.now() } = {}) {
  if (typeof path !== 'string' || path === '') return 0;
  const rows = (Array.isArray(materials) ? materials : [])
    .filter((m) => m !== null && typeof m === 'object')
    .filter((m) => m.source === 'bili-hot' || m.source === 'bili-popular')
    .map((m) => ({
      at,
      source: m.source,
      text: typeof m.text === 'string' ? m.text : '',
      bvid: typeof m.bvid === 'string' ? m.bvid : '',
      title: typeof m.title === 'string' ? m.title : ''
    }))
    .filter((m) => m.text !== '' || m.title !== '');
  if (rows.length === 0) return 0;
  for (const row of rows) appendJsonl(path, row);
  return rows.length;
}

/** 取指定日期的素材（按本地时区算日子）。坏行跳过。 */
export function trendsForDay(path, { now = Date.now(), zoneOffsetMinutes = 0 } = {}) {
  const today = dayKey(now, zoneOffsetMinutes);
  return readJsonl(path).filter((row) => {
    const at = Number(row?.at);
    if (!Number.isFinite(at)) return false;
    return dayKey(at, zoneOffsetMinutes) === today;
  });
}

/** 现在该不该写今天这份。 */
export function shouldCollectTrends({
  now = Date.now(),
  startAt = DEFAULT_TRENDS_START_AT,
  lastDay = '',
  zoneOffsetMinutes = 0,
  materials = 0
} = {}) {
  const at = clockMinutes(startAt);
  if (at === null) return { collect: false, reason: `bad_start(${startAt})` };
  const local = new Date(now + zoneOffsetMinutes * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const today = dayKey(now, zoneOffsetMinutes);
  if (lastDay === today) return { collect: false, reason: 'already_collected_today' };
  if (materials <= 0) return { collect: false, reason: 'nothing_collected' };

  const elapsed = minutes >= at ? minutes - at : minutes + 1440 - at;
  if (elapsed > TRENDS_WINDOW_MINUTES) {
    // 凌晨时分：如果离今晚开始还早，算"还没到点"；否则就是昨晚那趟错过了。
    if (minutes < at && at - minutes <= NOON_MINUTES) return { collect: false, reason: `before_start(${at - minutes}m)` };
    return { collect: false, reason: 'too_late' };
  }
  return { collect: true, reason: 'due', date: today };
}

/**
 * 写今天这份的提示词。投进主会话，我当场整理、查梗源、写成 markdown。
 * 不列一堆规矩，把要求说清楚就行。
 */
export function buildTrendPrompt({ date, rows, outPath, maxItems = 40 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, maxItems);
  if (list.length === 0) return '';
  const lines = list.map((row, i) => {
    const tag = row.source === 'bili-hot' ? '热搜' : '热门';
    const bv = row.bvid !== '' ? `  [${row.bvid}]` : '';
    return `${i + 1}. （${tag}）${row.text}${bv}`;
  });
  return [
    `[每天的热梗收档 ${new Date().toISOString()}]`,
    '',
    `今天的素材收在下面了，整理成一份写到 \`${outPath}\`（日期 ${date}）。`,
    '',
    '## 今天收到的',
    ...lines,
    '',
    '## 怎么写',
    '- 热搜十个全列出来，逐个标「能用 / 不能用」，不能用的写一句为什么。热搜是梗的主要来源。',
    '- 从里面挑**一条主梗**，往四个方向挖：来源链条（最早是谁说的、怎么被挪到这个人身上的）、触发事件（今天为什么上热搜）、用法（什么场合套什么句式）、为什么好用（形状够不够简单、能不能反转）。',
    '- 出处查不准就自己去查：`bili search video "<关键词> 是什么梗"`，字幕能读就读，读不到就写明「没查到出处」，别编。',
    '- 热搜没梗的时候，从热门视频里补，记下 bvid。',
    '- 最后给一份「可用清单」：三条以内，写成模板，不要写成新闻摘要。',
    '',
    '## 规矩',
    '- 只读，不投币不发评论不关注。',
    '- 这份不进长期记忆，是即用即弃的稿子，别往 engram 里塞。',
    '- 写完用 `purpose_trends_done` 记一下，不然下个 tick 还会催。'
  ].join('\n');
}

/** 今天这份写完了没有。 */
export function readTrendsState(path) {
  return readJson(path, {});
}

export function markTrendsDone(path, { now = Date.now(), zoneOffsetMinutes = 0, count = 0 } = {}) {
  writeJsonAtomic(path, {
    lastDay: dayKey(now, zoneOffsetMinutes),
    lastAt: new Date(now).toISOString(),
    count
  });
}
