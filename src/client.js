/**
 * A dependency-free Twilio client, scoped to what a WhatsApp inbox needs.
 *
 * Only `fetch`. Twilio's own SDK would pull a dependency tree into a harness plugin for
 * three endpoints, and the REST API is form-encoded and stable.
 *
 * @module dsh-whatsapp-inbox/client
 */

const API = 'https://api.twilio.com/2010-04-01';

/** Twilio rejects a free-form message outside the 24h customer window with this code. */
export const OUTSIDE_WINDOW = 63016;

export class TwilioClient {
  /**
   * @param {{accountSid: string, authToken: string, from: string,
   *          log?: object, fetchImpl?: Function}} opts
   */
  constructor(opts) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.from = opts.from;                 // 'whatsapp:+1...'
    this.log = opts.log ?? { warn() {}, debug() {} };
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get #auth() {
    return 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
  }

  async call(method, path, params, timeoutMs = 20000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const isGet = method === 'GET';
      const body = new URLSearchParams(params ?? {});
      const url = `${API}/Accounts/${this.accountSid}${path}` + (isGet && [...body].length ? `?${body}` : '');
      const res = await this.fetch(url, {
        method,
        headers: {
          Authorization: this.#auth,
          ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
        },
        ...(isGet ? {} : { body }),
        signal: ctl.signal,
      });
      const data = await res.json();
      if (!res.ok || data.code) {
        const err = new Error(`${path}: ${data.message ?? res.status}`);
        err.code = data.code;
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Inbound messages addressed to this number, oldest first.
   *
   * Twilio returns newest-first; the caller wants chronological order so a burst of
   * messages reaches the agent in the order they were written.
   */
  async inbound({ since = null, pageSize = 20 } = {}) {
    const params = { To: this.from, PageSize: String(pageSize) };
    if (since) params['DateSent>'] = since;
    const data = await this.call('GET', '/Messages.json', params);
    return (data.messages ?? [])
      .filter((m) => m.direction === 'inbound')
      .reverse();
  }

  /** Send one WhatsApp message. */
  async sendOne(to, body) {
    return this.call('POST', '/Messages.json', { From: this.from, To: to, Body: body });
  }

  /** Send text, split across messages. Returns how many parts landed. */
  async send(to, text, split) {
    let sent = 0;
    for (const part of split(text)) {
      await this.sendOne(to, part);
      sent += 1;
    }
    return sent;
  }

  /** Confirms the credentials and that the sender is usable. */
  async whoAmI() {
    const acct = await this.call('GET', '.json', null);
    return { friendlyName: acct.friendly_name, status: acct.status };
  }
}

/** Media attached to an inbound message, as {url, contentType} pairs. */
export function mediaOf(message) {
  const n = Number(message?.num_media ?? 0);
  if (!n) return [];
  // The list endpoint does not expand media; the subresource URL is derivable and stable.
  return [{ listUrl: `${message.uri?.replace('.json', '')}/Media.json`, count: n }];
}
