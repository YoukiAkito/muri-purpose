import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordTrends,
  trendsForDay,
  shouldCollectTrends,
  buildTrendPrompt,
  markTrendsDone,
  readTrendsState,
  dayKey
} from '../src/trends.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'trends-'));
}

test('recordTrends 只收热搜和热门两路，念头搜索不算热梗', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'trends.jsonl');
    const n = recordTrends(path, {
      at: 1_700_000_000_000,
      materials: [
        { source: 'bili-hot', text: 'B站热搜：Chovy同意了是什么梗', bvid: '', title: '' },
        { source: 'bili-popular', text: 'B站热门视频：灭建国', bvid: 'BV1bzsV6nEM6', title: '灭建国' },
        { source: 'bili-topic', text: '搜「热梗」：随便一条', bvid: 'BVxxx', title: '随便一条' }
      ]
    });
    assert.equal(n, 2);
    const rows = trendsForDay(path, { now: 1_700_000_000_000, zoneOffsetMinutes: 0 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.source), ['bili-hot', 'bili-popular']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordTrends 空素材不写文件', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'trends.jsonl');
    assert.equal(recordTrends(path, { materials: [] }), 0);
    assert.equal(recordTrends(path, { materials: null }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trendsForDay 只返回当天的，跨天的不算', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'trends.jsonl');
    const today = 1_700_000_000_000;
    recordTrends(path, { at: today - 3 * 86_400_000, materials: [{ source: 'bili-hot', text: '前天的事' }] });
    recordTrends(path, { at: today, materials: [{ source: 'bili-hot', text: '今天的事' }] });
    const rows = trendsForDay(path, { now: today, zoneOffsetMinutes: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '今天的事');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldCollectTrends：到点了、有素材、今天还没写 → due', () => {
  // 2026-11-16T13:40:00Z 在 UTC+8 是 21:40，startAt 21:30
  const now = Date.parse('2026-11-16T13:40:00Z');
  const verdict = shouldCollectTrends({ now, startAt: '21:30', zoneOffsetMinutes: 480, materials: 12 });
  assert.equal(verdict.collect, true);
  assert.equal(verdict.reason, 'due');
  assert.equal(verdict.date, '2026-11-16');
});

test('shouldCollectTrends：今天写过了就不再写', () => {
  const now = Date.parse('2026-11-16T13:40:00Z');
  const verdict = shouldCollectTrends({
    now,
    startAt: '21:30',
    zoneOffsetMinutes: 480,
    lastDay: '2026-11-16',
    materials: 12
  });
  assert.equal(verdict.collect, false);
  assert.equal(verdict.reason, 'already_collected_today');
});

test('shouldCollectTrends：没素材就不写空稿', () => {
  const now = Date.parse('2026-11-16T13:40:00Z');
  const verdict = shouldCollectTrends({ now, startAt: '21:30', zoneOffsetMinutes: 480, materials: 0 });
  assert.equal(verdict.collect, false);
  assert.equal(verdict.reason, 'nothing_collected');
});

test('shouldCollectTrends：还没到点不催', () => {
  // UTC+8 的 18:00，离 21:30 还有三个半小时
  const now = Date.parse('2026-11-16T10:00:00Z');
  const verdict = shouldCollectTrends({ now, startAt: '21:30', zoneOffsetMinutes: 480, materials: 5 });
  assert.equal(verdict.collect, false);
  assert.match(verdict.reason, /^before_start\(/);
});

test('shouldCollectTrends：过了窗口就算了，不补跑', () => {
  // UTC+8 的 05:00，离昨晚 21:30 已经七个半小时
  const now = Date.parse('2026-11-15T21:00:00Z');
  const verdict = shouldCollectTrends({ now, startAt: '21:30', zoneOffsetMinutes: 480, materials: 5 });
  assert.equal(verdict.collect, false);
  assert.equal(verdict.reason, 'too_late');
});

test('shouldCollectTrends：startAt 写坏了就明说，不瞎跑', () => {
  const verdict = shouldCollectTrends({ now: Date.now(), startAt: '25:99', materials: 5 });
  assert.equal(verdict.collect, false);
  assert.match(verdict.reason, /^bad_start\(/);
});

test('buildTrendPrompt：没有素材返回空串', () => {
  assert.equal(buildTrendPrompt({ date: '2026-11-16', rows: [], outPath: '/tmp/x.md' }), '');
});

test('buildTrendPrompt：装上素材、落盘路径和四条写法要求', () => {
  const prompt = buildTrendPrompt({
    date: '2026-11-16',
    outPath: '/Users/chenmeng/.dsh/trends/2026-11-16.md',
    rows: [
      { source: 'bili-hot', text: 'B站热搜：Chovy同意了是什么梗', bvid: '' },
      { source: 'bili-popular', text: 'B站热门视频：灭建国', bvid: 'BV1bzsV6nEM6' }
    ]
  });
  assert.match(prompt, /每天的热梗收档/);
  assert.match(prompt, /2026-11-16\.md/);
  assert.match(prompt, /（热搜）B站热搜：Chovy同意了是什么梗/);
  assert.match(prompt, /\[BV1bzsV6nEM6\]/);
  // 四条写法：全列并标能不能用、挖一条主梗、查不到就写查不到、可用清单写成模板
  assert.match(prompt, /热搜十个全列出来/);
  assert.match(prompt, /来源链条/);
  assert.match(prompt, /别编/);
  assert.match(prompt, /可用清单/);
  // 不进长期记忆这条得明说，否则我会顺手写进 engram
  assert.match(prompt, /不进长期记忆/);
});

test('buildTrendPrompt：素材超上限就截断', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ source: 'bili-hot', text: `标题${i}` }));
  const prompt = buildTrendPrompt({ date: '2026-11-16', rows, outPath: '/tmp/x.md', maxItems: 5 });
  assert.match(prompt, /标题4/);
  assert.doesNotMatch(prompt, /标题5/);
});

test('markTrendsDone 写下去之后 shouldCollectTrends 当天就不催了', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'trends-state.json');
    const now = Date.parse('2026-11-16T13:40:00Z');
    markTrendsDone(path, { now, zoneOffsetMinutes: 480, count: 12 });
    const state = readTrendsState(path);
    assert.equal(state.lastDay, '2026-11-16');
    assert.equal(state.count, 12);
    const verdict = shouldCollectTrends({
      now,
      startAt: '21:30',
      zoneOffsetMinutes: 480,
      lastDay: state.lastDay,
      materials: 12
    });
    assert.equal(verdict.collect, false);
    assert.equal(verdict.reason, 'already_collected_today');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dayKey 按给定时区换算日期', () => {
  // UTC 20:00 在 UTC+8 已经是第二天 04:00
  const ms = Date.parse('2026-11-16T20:00:00Z');
  assert.equal(dayKey(ms, 0), '2026-11-16');
  assert.equal(dayKey(ms, 480), '2026-11-17');
});
