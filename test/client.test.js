import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwilioClient, OUTSIDE_WINDOW } from '../src/client.js';

const client = (fetchImpl) => new TwilioClient({
  accountSid: 'AC123', authToken: 'tok', from: 'whatsapp:+1999', fetchImpl,
});
const ok = (payload) => async () => ({ ok: true, json: async () => payload });

test('inbound is filtered to this number and returned oldest-first', async () => {
  let seen;
  const c = client(async (url) => {
    seen = url;
    return { ok: true, json: async () => ({ messages: [
      { sid: 'B', direction: 'inbound', date_sent: 'b' },
      { sid: 'A', direction: 'inbound', date_sent: 'a' },
    ] }) };
  });
  const out = await c.inbound();
  assert.match(seen, /To=whatsapp%3A%2B1999/, 'must scope the query to our sender');
  assert.deepEqual(out.map((m) => m.sid), ['A', 'B'], 'Twilio returns newest-first; we want reading order');
});

test('outbound messages are excluded — we must never answer ourselves', async () => {
  const c = client(ok({ messages: [
    { sid: 'A', direction: 'inbound' },
    { sid: 'B', direction: 'outbound-api' },
  ] }));
  assert.deepEqual((await c.inbound()).map((m) => m.sid), ['A']);
});

test('a since filter is passed as DateSent>', async () => {
  let seen;
  const c = client(async (url) => { seen = url; return { ok: true, json: async () => ({ messages: [] }) }; });
  await c.inbound({ since: '2026-08-21T03:00:00Z' });
  assert.match(decodeURIComponent(seen), /DateSent>=?2026-08-21T03:00:00Z/);
});

test('the 24h-window rejection is surfaced with its code, not swallowed', async () => {
  const c = client(async () => ({ ok: false, json: async () => ({ code: OUTSIDE_WINDOW, message: 'outside window' }) }));
  await assert.rejects(() => c.sendOne('whatsapp:+1', 'hi'), (e) => e.code === OUTSIDE_WINDOW);
});

test('send splits and posts each part with the right sender', async () => {
  const posts = [];
  const c = client(async (url, init) => {
    posts.push(Object.fromEntries(new URLSearchParams(init.body)));
    return { ok: true, json: async () => ({ sid: 'SM' }) };
  });
  const { splitMessage } = await import('../src/chunk.js');
  const n = await c.send('whatsapp:+1555', 'y'.repeat(4000), splitMessage);
  assert.ok(n >= 3);
  assert.equal(posts.length, n);
  assert.equal(posts[0].From, 'whatsapp:+1999');
  assert.equal(posts[0].To, 'whatsapp:+1555');
});

test('credentials go in the Authorization header, never the URL', async () => {
  let url, init;
  const c = client(async (u, i) => { url = u; init = i; return { ok: true, json: async () => ({ friendly_name: 'x', status: 'active' }) }; });
  await c.whoAmI();
  assert.doesNotMatch(url, /tok/, 'the auth token must not appear in a URL');
  assert.match(init.headers.Authorization, /^Basic /);
});
