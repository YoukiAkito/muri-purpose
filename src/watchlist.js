/**
 * 待看清单：白天翻标题时记下想看的，晚上再真去看。
 *
 * 为什么分两步：
 *   出门那一步只拿到标题、播放量、UP 主——看的是壳，不是内容。
 *   真看一条视频要抽帧、转台词，一分钟起步，不能塞在 tick 里做。
 *   所以白天只做判断（哪条值得看、为什么），晚上再一条条打开看。
 *
 * 「为什么选它」是这份清单的重点：
 *   只存标题的话，晚上打开时不知道自己白天在惦记什么，跟随机点开没区别。
 *   挑的时候写一句当时的念头，晚上就知道该盯着哪里看。
 *
 * 落盘：<dataDir>/watchlist.jsonl，append-only。
 *   同一 bvid 后来写的行覆盖前面的（fold 取最新），这样改状态不用重写整个文件。
 */
import { appendJsonl, readJsonl } from './util.js';

/** 清单里最多留多少条；超了按时间砍最老的。 */
export const DEFAULT_MAX_CANDIDATES = 40;

export const WATCH_STATE = Object.freeze({
  /** 白天翻到、还没决定要不要看。 */
  CANDIDATE: 'candidate',
  /** 挑中了，等着晚上看。 */
  PICKED: 'picked',
  /** 看过了，note 里是当时的笔记。 */
  WATCHED: 'watched',
  /** 放弃了（打开发现没意思，或者没时间）。 */
  DROPPED: 'dropped'
});

const STATES = new Set(Object.values(WATCH_STATE));

function text(value, max = 0) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return max > 0 && raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * 素材 → 候选行。
 *
 * 没有 bvid 的（热搜只有关键词）直接跳过：点不开的东西记下来也没法看。
 */
export function candidatesFromMaterials(materials, { at = Date.now() } = {}) {
  const out = [];
  for (const item of Array.isArray(materials) ? materials : []) {
    const bvid = text(item?.bvid, 32);
    if (bvid === '') continue;
    const title = text(item?.title, 120);
    if (title === '') continue;
    out.push({
      at,
      bvid,
      title,
      source: text(item?.source, 40),
      state: WATCH_STATE.CANDIDATE,
      why: '',
      note: ''
    });
  }
  return out;
}

/**
 * 把流水折叠成「每个 bvid 的最新状态」，按最近一次出现的时间倒序。
 *
 * 坏行、缺 bvid 的行直接丢——清单不该因为一行脏数据整个读不出来。
 */
export function foldWatchlist(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const bvid = text(row?.bvid, 32);
    if (bvid === '') continue;
    const prev = byId.get(bvid);
    const next = {
      bvid,
      title: text(row?.title, 120) || prev?.title || '',
      source: text(row?.source, 40) || prev?.source || '',
      state: STATES.has(row?.state) ? row.state : prev?.state ?? WATCH_STATE.CANDIDATE,
      why: text(row?.why, 200) || prev?.why || '',
      note: text(row?.note, 800) || prev?.note || '',
      at: Number(row?.at) || prev?.at || 0,
      pickedAt: Number(row?.pickedAt) || prev?.pickedAt || 0,
      watchedAt: Number(row?.watchedAt) || prev?.watchedAt || 0
    };
    byId.set(bvid, next);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

/** 读清单（折叠后）。文件不存在就是空数组。 */
export function readWatchlist(path) {
  if (typeof path !== 'string' || path === '') return [];
  return foldWatchlist(readJsonl(path));
}

/**
 * 白天翻完标题，把能点开的记下来。
 *
 * 已经出现过的 bvid 不再写——同一个视频刷到三次不该在清单里占三行。
 * @returns {number} 这次新增了几条
 */
export function recordCandidates(path, materials, { at = Date.now(), maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  if (typeof path !== 'string' || path === '') return 0;
  const known = new Set(readWatchlist(path).map((row) => row.bvid));
  const fresh = candidatesFromMaterials(materials, { at }).filter((row) => !known.has(row.bvid));
  if (fresh.length === 0) return 0;

  const existing = readWatchlist(path);
  // 超出上限就先按时间砍最老的候选，只砍还没被挑中的——挑中的是白天的判断，不能丢。
  const room = Math.max(0, maxCandidates - existing.length);
  const keep = fresh.slice(0, Math.max(0, room));
  for (const row of keep) appendJsonl(path, row);
  return keep.length;
}

/**
 * 挑中几条，写清楚为什么。
 *
 * picks: [{bvid, why}]；why 空也能挑（只是晚上少一条线索），但会记成空串。
 * @returns {{picked: string[], missing: string[]}}
 */
export function pickCandidates(path, picks, { at = Date.now() } = {}) {
  const picked = [];
  const missing = [];
  const current = new Map(readWatchlist(path).map((row) => [row.bvid, row]));
  for (const pick of Array.isArray(picks) ? picks : []) {
    const bvid = text(pick?.bvid, 32);
    if (bvid === '') continue;
    const found = current.get(bvid);
    if (found === undefined) {
      missing.push(bvid);
      continue;
    }
    appendJsonl(path, {
      ...found,
      at,
      state: WATCH_STATE.PICKED,
      why: text(pick?.why, 200) || found.why,
      pickedAt: at
    });
    picked.push(bvid);
  }
  return { picked, missing };
}

/** 看完了，记一句笔记。 */
export function markWatched(path, { bvid, note, at = Date.now() } = {}) {
  const id = text(bvid, 32);
  if (id === '') return false;
  const found = readWatchlist(path).find((row) => row.bvid === id);
  if (found === undefined) return false;
  appendJsonl(path, {
    ...found,
    at,
    state: WATCH_STATE.WATCHED,
    note: text(note, 800) || found.note,
    watchedAt: at
  });
  return true;
}

/** 打开发现没意思/没看完，放弃。 */
export function markDropped(path, { bvid, note, at = Date.now() } = {}) {
  const id = text(bvid, 32);
  if (id === '') return false;
  const found = readWatchlist(path).find((row) => row.bvid === id);
  if (found === undefined) return false;
  appendJsonl(path, {
    ...found,
    at,
    state: WATCH_STATE.DROPPED,
    note: text(note, 800) || found.note
  });
  return true;
}

/** 晚上该看的：挑中了、还没看过的。挑得越早排越前。 */
export function pickedForWatch(path, { limit = 3 } = {}) {
  return readWatchlist(path)
    .filter((row) => row.state === WATCH_STATE.PICKED)
    .sort((a, b) => a.pickedAt - b.pickedAt)
    .slice(0, Math.max(0, Number(limit) || 0));
}
