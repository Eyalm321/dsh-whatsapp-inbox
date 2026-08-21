import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the plugin exports the Cordis surface', async () => {
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'dsh-whatsapp-inbox');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['agents']);
});

test('numberOf reduces a whatsapp address to a stable session key', async () => {
  const { numberOf } = await import('../src/index.js');
  assert.equal(numberOf('whatsapp:+15550001111'), '15550001111');
  assert.equal(numberOf('+15550001111'), '15550001111');
  assert.equal(numberOf(undefined), '');
});

test('an env-style credentials file is parsed, quotes and export included', async () => {
  const { parseEnvFile } = await import('../src/index.js');
  const got = parseEnvFile(`# comment\nexport TWILIO_ACCOUNT_SID=AC1\nTWILIO_AUTH_TOKEN="secret"\nJUNK\n`);
  assert.equal(got.TWILIO_ACCOUNT_SID, 'AC1');
  assert.equal(got.TWILIO_AUTH_TOKEN, 'secret');
});

test('visibleText keeps text blocks and drops reasoning', async () => {
  const { visibleText } = await import('../src/index.js');
  assert.equal(visibleText({ content: [{ type: 'text', text: 'a' }, { type: 'reasoning' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(visibleText(undefined), '');
});

test('apply gives up when the sender is missing rather than half-starting', async () => {
  const { apply } = await import('../src/index.js');
  const lines = [];
  const ctx = { agents: {}, get: () => undefined, on: () => {}, effect: () => { throw new Error('must not mount'); } };
  const orig = console.error; console.error = (m) => lines.push(String(m));
  try { apply(ctx, { accountSid: 'AC1', authToken: 't' }); } finally { console.error = orig; }
  assert.ok(lines.some((l) => /no sender/.test(l)));
});
