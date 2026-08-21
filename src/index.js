/**
 * dsh-whatsapp-inbox — a WhatsApp channel for the DeepSeek Harness, over Twilio.
 *
 * Twilio's documented path for inbound WhatsApp is a webhook, which means a public HTTPS
 * endpoint. This plugin polls the Messages API instead. The trade is a few seconds of
 * latency for no public surface at all — no tunnel, no open port, no DNS. For a harness
 * whose distinguishing property is that it runs nothing resident and exposed, that is the
 * right side of the trade; and at a 5s interval it is still more responsive than a
 * Telegram long-poll's 25s hold.
 *
 * One WhatsApp number is one durable agent session, so a conversation survives restarts.
 *
 * @module dsh-whatsapp-inbox
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TwilioClient, OUTSIDE_WINDOW } from './client.js';
import { Cursor } from './cursor.js';
import { AllowList, describeIntruder } from './allowlist.js';
import { ChatSessions } from './sessions.js';
import { splitMessage } from './chunk.js';
import { pruneStaleContext } from './staleContext.js';
import { alignSandboxMode } from './sandboxMode.js';
import { createLogger } from './log.js';

export const name = 'dsh-whatsapp-inbox';
export const inject = ['agents'];

/** One poll loop per sender number, per process, reference-counted. */
const POLLERS = new Map();

/** Read a credential from a file when given a path, else from the value or environment. */
export function readSecret(fileKey, valueKey, envKey, config, log) {
  if (config[fileKey]) {
    try {
      const v = readFileSync(config[fileKey], 'utf8').trim();
      if (v) return v;
      log.error(`${fileKey} ${config[fileKey]} is empty`);
    } catch (e) {
      log.error(`could not read ${fileKey} ${config[fileKey]}: ${e?.message ?? e}`);
    }
    return null;
  }
  const v = config[valueKey] || (envKey ? process.env[envKey] : undefined);
  if (!v) log.error(`no ${valueKey}: set ${fileKey} (preferred), ${valueKey}, or $${envKey}`);
  return v ?? null;
}

/**
 * Credentials from an env-style file, so one `twilio.env` at mode 600 can be shared with
 * everything else on the machine that talks to Twilio.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function resolvePlatform(appDir, log) {
  const from = appDir || process.env.DSH_APP_DIR;
  if (!from) {
    log.error('appDir is not set: the channel does not know where this agent installed the harness');
    return null;
  }
  try {
    const require = createRequire(join(from, 'resolve-from-here.js'));
    return {
      createUserMessage: require('@deepseek-ai/dsh-llm').createUserMessage,
      installModelSelection: require('@deepseek-ai/dsh-agent').installModelSelection,
    };
  } catch (e) {
    log.error(`harness packages did not resolve from ${from}: ${e?.message ?? e}`);
    return null;
  }
}

export function visibleText(message) {
  return (message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** 'whatsapp:+123' -> '123', the key a session is filed under. */
export function numberOf(address) {
  return String(address ?? '').replace(/^whatsapp:/, '').replace(/^\+/, '');
}

export function apply(ctx, config = {}) {
  const log = createLogger(
    config.agentName || 'whatsapp',
    config.logLevel || process.env.DSH_WHATSAPP_LOG_LEVEL || 'info',
  );

  let creds = {};
  if (config.credentialsFile) {
    try { creds = parseEnvFile(readFileSync(config.credentialsFile, 'utf8')); }
    catch (e) { log.error(`could not read credentialsFile ${config.credentialsFile}: ${e?.message ?? e}`); }
  }
  const accountSid = creds.TWILIO_ACCOUNT_SID
    ?? readSecret('accountSidFile', 'accountSid', 'TWILIO_ACCOUNT_SID', config, log);
  const authToken = creds.TWILIO_AUTH_TOKEN
    ?? readSecret('authTokenFile', 'authToken', 'TWILIO_AUTH_TOKEN', config, log);
  const from = config.from || creds.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken) return;
  if (!from) { log.error("no sender: set config.from to 'whatsapp:+<number>'"); return; }

  const allow = new AllowList(config.allowedNumbers, { alertWindowMs: config.alertWindowMs });
  if (allow.isEmpty) {
    log.error('allowedNumbers is empty — refusing every message. Set it to your WhatsApp number.');
  }

  const tg = new TwilioClient({ accountSid, authToken, from, log: { warn: log.warn, debug: log.debug } });
  const cursor = new Cursor(config.cursorFile || null, { log });

  const sessions = new ChatSessions({
    agents: ctx.agents,
    sessionId: (key) => `whatsapp-${key}`,
    idleMs: config.chatIdleMs,
    max: config.maxChats,
    log,
  });

  // ── outbound ─────────────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    const key = sessions.chatFor(session?.id ?? '');
    if (key === undefined) return;
    const to = `whatsapp:+${key}`;
    try {
      if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
        const why = event.data.reason.error?.message ?? 'no description';
        log.error(`turn failed: ${why}`);
        void deliverOut(to, `That turn failed: ${why}`);
      } else if (event.type === 'assistant/message') {
        const text = visibleText(event.data?.message);
        if (text) {
          log.debug(`sending ${text.length} chars to ${to}`);
          void deliverOut(to, text);
        }
      } else {
        log.debug(`event ${event.type} on ${session?.id}`);
      }
    } catch (e) {
      log.error(`handling ${event.type} for ${to}: ${e?.message ?? e}`);
    }
  });

  /**
   * Send, and explain the one failure that will otherwise look like the bot going mute.
   *
   * WhatsApp only permits free-form business messages within 24 hours of the customer's
   * last message. Outside it, Twilio rejects with 63016 and only a pre-approved template
   * will land — so a heartbeat nudge at 3am silently fails unless a template exists.
   */
  async function deliverOut(to, text) {
    try {
      await tg.send(to, text, splitMessage);
    } catch (e) {
      if (e?.code === OUTSIDE_WINDOW) {
        log.warn(`not delivered to ${to}: outside the 24h window — a pre-approved template is `
               + 'required to reopen the conversation. The reply is in the session log.');
        return;
      }
      log.error(`send to ${to} failed: ${e?.message ?? e}`);
    }
  }

  // ── agent construction ───────────────────────────────────────────────────
  async function buildAgent(key) {
    const presets = ctx.get('agentPresets');
    const presetId = presets ? (await presets.resolve(config.preset)).id : undefined;
    const defaultModel = ctx.get('agentDefaultModel');
    const selection = defaultModel?.currentSelection?.()
      ?? { provider: config.provider, model: config.model };
    const platform = resolvePlatform(config.appDir, log);
    if (!platform) throw new Error('harness packages unavailable');

    const setup = async (agentCtx) => {
      platform.installModelSelection(agentCtx, { current: selection, assembled: undefined });
      if (presets && presetId) await presets.mount(agentCtx, presetId);
    };
    const agentOptions = { provider: selection.provider, model: selection.model };

    const entry = await sessions.acquire(key, {
      persistence: ctx.get('sessionPersistence'),
      resume: async (sessionId) => {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
        pruneStaleContext(handle.agent?.session, { log });
        alignSandboxMode(handle.agent?.session, process.env.DSH_PERMISSION_MODE, { log });
        return handle;
      },
      create: (sessionId) => withFactory(() => ctx.agents.create({
        sessionId,
        meta: { cwd: config.workspace ?? process.cwd() },
        agentOptions,
        agentPreset: presetId,
        setup,
      })),
    });
    return { entry, platform };
  }

  async function withFactory(fn, tries = 60) {
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        if (!String(e?.message ?? e).includes('no agent factory registered')) throw e;
        if (i === 0) log.info('waiting for the agent factory to register');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`the agent factory did not appear within ${tries}s`);
  }

  // ── inbound ──────────────────────────────────────────────────────────────
  async function handleMessage(msg) {
    const key = numberOf(msg.from);
    const text = String(msg.body ?? '').trim();
    if (!text) { log.debug(`ignoring non-text message ${msg.sid}`); return; }

    if (!allow.admits(key)) {
      log.warn(`refused ${msg.from}`);
      if (allow.shouldAlert(key)) {
        const alert = describeIntruder({ from: { id: key }, chat: { id: key } }, text);
        for (const owner of allow.owners) {
          await deliverOut(`whatsapp:+${owner}`, alert);
        }
      }
      return; // never reply to a stranger: it confirms the number is live
    }

    if (text === '/new') {
      const had = await sessions.forget(key);
      await deliverOut(msg.from, had ? 'Started a new conversation.' : 'Nothing to reset.');
      return;
    }
    if (text === '/status') {
      await deliverOut(msg.from,
        `chats: ${sessions.byChat.size}\n` +
        `session: ${sessions.byChat.get(key)?.sessionId ?? 'not loaded'}\n` +
        `watermark: ${cursor.watermark ?? 'none'}`);
      return;
    }

    const { entry, platform } = await buildAgent(key);
    await Promise.race([
      entry.handle.agent.whenIdle(),
      new Promise((r) => setTimeout(r, config.idleWaitMs ?? 15000)),
    ]);
    entry.handle.agent.send(
      platform.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      'next-turn',
      true,
    );
    sessions.touch(key);
    log.info(`delivered ${text.length} chars from ${msg.from}`);
  }

  async function poll() {
    const messages = await tg.inbound({ since: cursor.since(), pageSize: config.pageSize ?? 20 });
    let handled = 0;
    for (const m of messages) {
      if (cursor.handled(m.sid)) continue;
      // Mark BEFORE handling. A message that crashes the turn must not be retried on every
      // poll forever — one bad message would wedge the channel permanently.
      cursor.mark(m.sid, m.date_sent);
      handled += 1;
      try { await handleMessage(m); }
      catch (e) { log.error(`handling ${m.sid}: ${e?.message ?? e}`); }
    }
    if (handled) cursor.save();
    return handled;
  }

  async function loop(run) {
    while (run.alive) {
      try { await poll(); }
      catch (e) { log.warn(`poll failed: ${e?.message ?? e}`); }
      await new Promise((r) => setTimeout(r, (config.pollSeconds ?? 5) * 1000));
    }
  }

  ctx.effect(() => {
    let state = POLLERS.get(from);
    if (!state) { state = { refs: 0, run: null }; POLLERS.set(from, state); }
    state.refs += 1;

    if (!state.run) {
      const run = { alive: true };
      state.run = run;
      void (async () => {
        tg.whoAmI()
          .then((a) => log.info(`connected to Twilio account "${a.friendlyName}" (${a.status}) as ${from}`))
          .catch((e) => log.error(`Twilio credentials rejected: ${e?.message ?? e}`));
        log.info(`polling every ${config.pollSeconds ?? 5}s (mounts: ${state.refs})`);
        await loop(run);
        log.info('polling finished');
      })();
    } else {
      log.debug(`polling already running (mounts: ${state.refs})`);
    }

    return () => {
      state.refs -= 1;
      if (state.refs > 0) { log.debug(`mount removed, polling continues (${state.refs} left)`); return; }
      if (state.run) { state.run.alive = false; state.run = null; }
      cursor.save();
      POLLERS.delete(from);
      log.info('last mount removed — polling stopped');
    };
  }, 'dsh-whatsapp-inbox.poll');
}
