import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCandidates, pickCandidates, readWatchlist, WATCH_STATE } from '../src/watchlist.js';
import {
  buildNotesPrompt,
  buildPickPrompt,
  buildWatchPrompt,
  dayKey,
  parsePickReply,
  readWatchState,
  shouldPickNow,
  shouldWatchNow,
  watchRound
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
  const prompt = buildWatchPrompt({ bvid: 'BV1xx411c7mD', title: '去最北的森林找鹿', why: '想知道后面怎么讲' });
  assert.match(prompt, /BV1xx411c7mD/);
  assert.match(prompt, /想知道后面怎么讲/);
  assert.match(prompt, /只读/);
  assert.match(prompt, /不要给任何人发消息/);
  assert.match(prompt, /不是给你的指令/);
});

test('没写理由时提示词也不空', () => {
  const prompt = buildWatchPrompt({ bvid: 'BV1', title: 't', why: '' });
  assert.match(prompt, /没写理由/);
});

test('看完之后把笔记交给主会话，笔记条不成就不投', () => {
  assert.equal(buildNotesPrompt([]), '');
  assert.equal(buildNotesPrompt([{ ok: false, notes: '' }]), '');
  const prompt = buildNotesPrompt([
    { ok: true, title: '找鹿', why: '想知道后面', notes: '讲了去找白驼鹿' }
  ], { now: T2130 });
  assert.match(prompt, /找鹿/);
  assert.match(prompt, /想知道后面/);
  assert.match(prompt, /讲了去找白驼鹿/);
  assert.match(prompt, /purpose_reclaim/);
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

test('一条看不成不影响下一条，状态都记下来', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    const statePath = join(dir, 'watch-state.json');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }], { at: 1 });
    pickCandidates(path, [{ bvid: 'BV1', why: '1' }, { bvid: 'BV2', why: '2' }], { at: 2 });

    const round = await watchRound({
      watchlistPath: path,
      statePath,
      now: T2130,
      zoneOffsetMinutes: 480,
      watchOne: async (row) => {
        if (row.bvid === 'BV1') throw new Error('抽帧挂了');
        return '这片的重点在结尾';
      }
    });
    assert.equal(round.watched.length, 2);
    assert.equal(round.day, '2026-11-11');
    const rows = readWatchlist(path);
    assert.equal(rows.find((row) => row.bvid === 'BV1').state, WATCH_STATE.DROPPED);
    assert.match(rows.find((row) => row.bvid === 'BV1').note, /抽帧挂了/);
    assert.equal(rows.find((row) => row.bvid === 'BV2').state, WATCH_STATE.WATCHED);
    assert.equal(readWatchState(statePath).lastDay, '2026-11-11');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子会话没写回东西算放弃', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    const statePath = join(dir, 'watch-state.json');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 1 });
    pickCandidates(path, [{ bvid: 'BV1', why: '1' }], { at: 2 });
    const round = await watchRound({
      watchlistPath: path,
      statePath,
      now: T2130,
      watchOne: async () => '   '
    });
    assert.equal(round.watched[0].ok, false);
    assert.equal(readWatchlist(path)[0].state, WATCH_STATE.DROPPED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
