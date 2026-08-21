import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cursor } from '../src/cursor.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'wac-')), 'nested', 'cursor.json');

test('a fresh cursor has no watermark and has handled nothing', () => {
  const c = new Cursor(fresh());
  assert.equal(c.watermark, null);
  assert.equal(c.handled('SM1'), false);
  assert.equal(c.since(), null, 'with no watermark the first poll must not be filtered');
});

test('handled messages survive a restart — the point of the cursor', () => {
  const f = fresh();
  const a = new Cursor(f);
  a.mark('SM1', 'Fri, 21 Aug 2026 02:35:04 +0000');
  a.save();
  const b = new Cursor(f);
  assert.equal(b.handled('SM1'), true);
  assert.ok(b.watermark);
});

test('the watermark only moves forward', () => {
  const c = new Cursor(null);
  c.mark('SM2', 'Fri, 21 Aug 2026 03:00:00 +0000');
  const high = c.watermark;
  c.mark('SM1', 'Fri, 21 Aug 2026 01:00:00 +0000');
  assert.equal(c.watermark, high, 'an older message must not rewind the watermark');
});

test('an unparseable date does not corrupt the watermark', () => {
  const c = new Cursor(null);
  c.mark('SM1', 'Fri, 21 Aug 2026 03:00:00 +0000');
  const good = c.watermark;
  c.mark('SM2', 'not a date');
  assert.equal(c.watermark, good);
  assert.equal(c.handled('SM2'), true, 'it is still handled, just not a watermark');
});

test('the poll filter rewinds, because a hard boundary drops same-second messages', () => {
  const c = new Cursor(null);
  c.mark('SM1', '2026-08-21T03:00:00Z');
  assert.ok(new Date(c.since()) < new Date(c.watermark));
});

test('a corrupt cursor file is treated as absent rather than fatal', () => {
  const f = fresh();
  const a = new Cursor(f); a.mark('SM1', '2026-08-21T03:00:00Z'); a.save();
  writeFileSync(f, 'not json');
  const b = new Cursor(f);
  assert.equal(b.watermark, null);
  assert.equal(b.handled('SM1'), false);
});

test('the seen set stays bounded so the file cannot grow forever', () => {
  const c = new Cursor(null);
  for (let i = 0; i < 1000; i++) c.mark(`SM${i}`, '2026-08-21T03:00:00Z');
  assert.ok(c.seen.size <= 400, `seen grew to ${c.seen.size}`);
  assert.equal(c.handled('SM999'), true, 'the most recent are always retained');
});
