import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, openFence, WHATSAPP_LIMIT } from '../src/chunk.js';

test('short text is one chunk with no counter', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('blank input sends nothing', () => {
  for (const v of ['', '  \n ', null, undefined]) assert.deepEqual(splitMessage(v), []);
});

test("every part fits Twilio's WhatsApp limit", () => {
  for (const c of splitMessage('word '.repeat(3000))) {
    assert.ok(c.length <= WHATSAPP_LIMIT, `part was ${c.length}`);
  }
});

test('split parts are numbered, because WhatsApp shows no grouping', () => {
  const parts = splitMessage('x '.repeat(3000));
  assert.ok(parts.length > 1);
  assert.match(parts[0], /^\(1\/\d+\)\n/);
  assert.match(parts.at(-1), new RegExp(`^\\(${parts.length}/${parts.length}\\)\\n`));
});

test('no content is lost across a split', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const joined = splitMessage(text).join('\n');
  for (const probe of ['line 0', 'line 150', 'line 299']) assert.ok(joined.includes(probe));
});

test('an open code fence is reopened in the next part', () => {
  const chunks = splitMessage('intro\n\n```python\n' + 'x = 1\n'.repeat(400) + '```\n');
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal((c.match(/^```/gm) ?? []).length % 2, 0, 'each part balances its fences');
  }
});

test('openFence reports the language of an unclosed fence', () => {
  assert.equal(openFence('```js\ncode'), 'js');
  assert.equal(openFence('```js\ncode\n```'), null);
});
