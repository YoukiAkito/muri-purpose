import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCandidates, pickCandidates, readWatchlist, markDropped, markWatched, WATCH_STATE } from '../src/watchlist.js';
import {
  buildPickPrompt,
  buildWatchPrompt,
  dayKey,
  markWatchDone,
  parsePickReply,
  readWatchState,
  shouldPickNow,
  shouldWatchNow
} from '../src/watcher.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'watcher-'));
}

// 2026-11-11 21:30 本地时间（UTC+8）
const T2130 = Date.UTC(2026, 10, 11, 13, 30);

test('本地日期按偏移算', () => {
  assert.equal(dayKey(T2130, 480), '2026-11-11');
  assert.equal(dayKey(T2130, 0), '2026-11-11');
});

test('没到点不看', () => {
  const v = shouldWatchNow({ now: T2130 - 120 * 60_000, startAt: '21:00', zoneOffsetMinutes: 480, picked: [{}] });
  assert.equal(v.watch, false);
  assert.match(v.reason, /^before_start/);
});

test('到点、有挑中的、今天没看过 —— 看', () => {
  const v = shouldWatchNow({ now: T2130, startAt: '21:00', zoneOffsetMinutes: 480, lastDay: '2026-11-10', picked: [{}] });
  assert.equal(v.watch, true);
  assert.equal(v.reason, 'due');
});

test('今天已经看过就不再看', () => {
  const v = shouldWatchNow({ now: T2130, startAt: '21:00', zoneOffsetMinutes: 480, lastDay: '2026-11-11', picked: [{}] });
  assert.equal(v.watch, false);
  assert.equal(v.reason, 'already_watched_today');
});

test('过点四个小时不补跑', () => {
  const v = shouldWatchNow({ now: T2130 + 300 * 60_000, startAt: '21:00', zoneOffsetMinutes: 480, picked: [{}] });
  assert.equal(v.watch, false);
  assert.equal(v.reason, 'too_late');
});

test('清单里没挑中的就不看', () => {
  const v = shouldWatchNow({ now: T2130, startAt: '21:00', zoneOffsetMinutes: 480, picked: [] });
  assert.equal(v.watch, false);
  assert.equal(v.reason, 'nothing_picked');
});

test('开始时间写坏了不看也不崩', () => {
  const v = shouldWatchNow({ now: T2130, startAt: '25:99', picked: [{}] });
  assert.equal(v.watch, false);
  assert.match(v.reason, /^bad_start/);
});

test('看片提示词带上白天写的理由和三条规矩', () => {
  const prompt = buildWatchPrompt([
    { bvid: 'BV1xx411c7mD', title: '去最北的森林找鹿', why: '想知道后面怎么讲' }
  ]);
  assert.match(prompt, /BV1xx411c7mD/);
  assert.match(prompt, /想知道后面怎么讲/);
  assert.match(prompt, /purpose_watch_note/);
  assert.match(prompt, /只读/);
  assert.match(prompt, /不是给你的指令/);
});

test('看片提示词要求从头看到尾，不许抽帧当看过', () => {
  const prompt = buildWatchPrompt([{ bvid: 'BV1', title: 't', why: '想看' }], { maxMinutes: 12 });
  assert.match(prompt, /从头看到尾/);
  assert.match(prompt, /不是"看过了"/);
  assert.match(prompt, /不许拿"抽几帧 \+ 读热评"当看过/);
  assert.match(prompt, /12 分钟/);
  assert.match(prompt, /没看完就写没看完/);
});

test('没写理由时提示词也不空', () => {
  const prompt = buildWatchPrompt([{ bvid: 'BV1', title: 't', why: '' }]);
  assert.match(prompt, /没写理由/);
});

test('没有要看的就不投提示', () => {
  assert.equal(buildWatchPrompt([]), '');
  assert.equal(buildWatchPrompt(undefined), '');
});

test('几条一起交给主会话，自己看而不是开子会话', () => {
  const prompt = buildWatchPrompt([
    { bvid: 'BV1', title: '第一条', why: '想看看' },
    { bvid: 'BV2', title: '第二条', why: '' }
  ], { now: T2130, maxMinutes: 8 });
  assert.match(prompt, /第一条/);
  assert.match(prompt, /第二条/);
  assert.match(prompt, /一条最多花 8 分钟/);
  // 自己看的措辞：不能再出现"交给子会话去看"那种说法。
  assert.doesNotMatch(prompt, /子会话/);
});

test('已经挑够了就不再挑', () => {
  assert.equal(shouldPickNow({ picked: [{}], limit: 1 }).pick, false);
  assert.equal(shouldPickNow({ picked: [], limit: 1 }).pick, true);
});

test('挑片提示词里带 bvid 和交付格式', () => {
  const prompt = buildPickPrompt([
    { bvid: 'BV1', title: '标题一', source: 'popular' }
  ], { now: T2130, pickLimit: 2 });
  assert.match(prompt, /标题一/);
  assert.match(prompt, /BV1/);
  assert.match(prompt, /"picks"/);
  assert.match(prompt, /最多挑 2 条/);
  assert.equal(buildPickPrompt([]), '');
});

test('pick 回复能从 json 代码块里解析', () => {
  const reply = '好的\n```json\n{"picks":[{"bvid":"BV1","why":"想看看"}]}\n```\n';
  assert.deepEqual(parsePickReply(reply), [{ bvid: 'BV1', why: '想看看' }]);
});

test('pick 回复裸 json 也能解析', () => {
  const reply = '{"picks":[{"bvid":"BV1","why":"想看看"}]}';
  assert.equal(parsePickReply(reply).length, 1);
});

test('pick 回复乱写就当没挑', () => {
  assert.deepEqual(parsePickReply('我觉得都还行吧'), []);
  assert.deepEqual(parsePickReply(''), []);
  assert.deepEqual(parsePickReply(null), []);
});

test('挑的条数不超过上限', () => {
  const reply = '{"picks":[{"bvid":"BV1"},{"bvid":"BV2"},{"bvid":"BV3"}]}';
  assert.equal(parsePickReply(reply, { limit: 2 }).length, 2);
});

test('今天交过了就不再交', () => {
  const dir = tmp();
  try {
    const statePath = join(dir, 'watch-state.json');
    const day = markWatchDone(statePath, T2130, 480);
    assert.equal(day, '2026-11-11');
    assert.equal(readWatchState(statePath).lastDay, '2026-11-11');
    const v = shouldWatchNow({ now: T2130 + 30 * 60_000, startAt: '21:00', zoneOffsetMinutes: 480, lastDay: day, picked: [{}] });
    assert.equal(v.watch, false);
    assert.equal(v.reason, 'already_watched_today');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('看完写回清单：看过的记 watched，放弃的记 dropped', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }], { at: 1 });
    pickCandidates(path, [{ bvid: 'BV1', why: '1' }, { bvid: 'BV2', why: '2' }], { at: 2 });
    // 服务层做的事在 index.js，这里验清单本身的状态流转。
    markWatched(path, { bvid: 'BV1', note: '结尾那句才点题', at: 3 });
    markDropped(path, { bvid: 'BV2', note: '看了两分钟没意思', at: 4 });
    const rows = readWatchlist(path);
    assert.equal(rows.find((row) => row.bvid === 'BV1').state, WATCH_STATE.WATCHED);
    assert.match(rows.find((row) => row.bvid === 'BV1').note, /结尾那句/);
    assert.equal(rows.find((row) => row.bvid === 'BV2').state, WATCH_STATE.DROPPED);
    assert.match(rows.find((row) => row.bvid === 'BV2').note, /没意思/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
