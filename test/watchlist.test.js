import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WATCH_STATE,
  candidatesFromMaterials,
  foldWatchlist,
  markDropped,
  markWatched,
  pickCandidates,
  pickedForWatch,
  readWatchlist,
  recordCandidates
} from '../src/watchlist.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'watchlist-'));
}

test('没有 bvid 的素材不进清单', () => {
  const rows = candidatesFromMaterials([
    { text: '热搜词', source: 'hot' },
    { bvid: 'BV1xx411c7mD', title: '一条视频', source: 'popular' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bvid, 'BV1xx411c7mD');
  assert.equal(rows[0].state, WATCH_STATE.CANDIDATE);
});

test('同一个 bvid 后来写的行覆盖前面的', () => {
  const folded = foldWatchlist([
    { bvid: 'BV1', title: '旧的', state: 'candidate', at: 100 },
    { bvid: 'BV1', state: 'picked', why: '想看看', pickedAt: 200, at: 200 }
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].state, 'picked');
  assert.equal(folded[0].why, '想看看');
  assert.equal(folded[0].title, '旧的');
  assert.equal(folded[0].pickedAt, 200);
});

test('清单按最近出现时间倒序', () => {
  const folded = foldWatchlist([
    { bvid: 'BVa', at: 100 },
    { bvid: 'BVb', at: 300 }
  ]);
  assert.deepEqual(folded.map((row) => row.bvid), ['BVb', 'BVa']);
});

test('已经记过的 bvid 不再写', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    const first = recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 1 });
    const again = recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 2 });
    assert.equal(first, 1);
    assert.equal(again, 0);
    assert.equal(readWatchlist(path).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('超过上限就不再收新的', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }], { at: 1, maxCandidates: 2 });
    const added = recordCandidates(path, [{ bvid: 'BV3', title: 'c' }], { at: 2, maxCandidates: 2 });
    assert.equal(added, 0);
    assert.equal(readWatchlist(path).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('挑中的留下理由，对不上的报 missing', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 1 });
    const result = pickCandidates(path, [
      { bvid: 'BV1', why: '想知道后面怎么讲' },
      { bvid: 'BV9', why: '不在清单里' }
    ], { at: 5 });
    assert.deepEqual(result.picked, ['BV1']);
    assert.deepEqual(result.missing, ['BV9']);
    const row = readWatchlist(path)[0];
    assert.equal(row.state, WATCH_STATE.PICKED);
    assert.equal(row.why, '想知道后面怎么讲');
    assert.equal(row.pickedAt, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('看完记笔记，状态变 watched', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 1 });
    pickCandidates(path, [{ bvid: 'BV1', why: 'w' }], { at: 2 });
    assert.equal(markWatched(path, { bvid: 'BV1', note: '讲的是找鹿', at: 3 }), true);
    const row = readWatchlist(path)[0];
    assert.equal(row.state, WATCH_STATE.WATCHED);
    assert.equal(row.note, '讲的是找鹿');
    assert.equal(row.watchedAt, 3);
    assert.equal(pickedForWatch(path).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('放弃要能记下原因', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }], { at: 1 });
    assert.equal(markDropped(path, { bvid: 'BV1', note: '没意思' }), true);
    assert.equal(readWatchlist(path)[0].state, WATCH_STATE.DROPPED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不在清单里的 bvid 标记失败而不是瞎写', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    assert.equal(markWatched(path, { bvid: 'BV404' }), false);
    assert.equal(markDropped(path, { bvid: 'BV404' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('晚上要看的是挑中且挑得最早的在前', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'watchlist.jsonl');
    recordCandidates(path, [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }], { at: 1 });
    pickCandidates(path, [{ bvid: 'BV2', why: '2' }], { at: 20 });
    pickCandidates(path, [{ bvid: 'BV1', why: '1' }], { at: 10 });
    assert.deepEqual(pickedForWatch(path).map((row) => row.bvid), ['BV1', 'BV2']);
    assert.equal(pickedForWatch(path, { limit: 1 }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
