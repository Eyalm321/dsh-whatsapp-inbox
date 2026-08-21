/**
 * Remembering which inbound messages have already been handled.
 *
 * Twilio has no long-poll and no acknowledgement: every list call returns the same
 * history again. Without a durable cursor a restart re-answers everything Twilio still
 * holds, which for WhatsApp is days of messages.
 *
 * The cursor is a watermark plus a bounded set of recently seen SIDs. The watermark alone
 * is not enough — Twilio timestamps have one-second resolution, so two messages in the
 * same second would let one slip past a strictly-greater comparison.
 *
 * @module dsh-whatsapp-inbox/cursor
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const KEEP_SIDS = 200;

export class Cursor {
  constructor(path, opts = {}) {
    this.path = path ?? null;
    this.log = opts.log ?? { warn() {} };
    const loaded = this.#load();
    this.watermark = loaded.watermark ?? null;   // ISO string of the newest handled message
    this.seen = new Set(loaded.seen ?? []);
  }

  #load() {
    if (!this.path) return {};
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8'));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }

  save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      // Keep only the recent tail: the watermark covers everything older.
      const seen = [...this.seen].slice(-KEEP_SIDS);
      writeFileSync(tmp, JSON.stringify({ watermark: this.watermark, seen }));
      renameSync(tmp, this.path);
    } catch (e) {
      this.log.warn(`could not persist the message cursor: ${e?.message ?? e}`);
    }
  }

  /** Has this message already been handled? */
  handled(sid) { return this.seen.has(sid); }

  /** Record a handled message and advance the watermark when it is newer. */
  mark(sid, dateSent) {
    this.seen.add(sid);
    if (this.seen.size > KEEP_SIDS * 2) {
      this.seen = new Set([...this.seen].slice(-KEEP_SIDS));
    }
    const at = dateSent ? new Date(dateSent) : null;
    if (at && !Number.isNaN(at.getTime())) {
      if (!this.watermark || at > new Date(this.watermark)) this.watermark = at.toISOString();
    }
  }

  /**
   * The `DateSent>=` filter for the next poll. Deliberately rewinds a little: Twilio's
   * filter is inclusive at second resolution and messages can be indexed slightly late,
   * so a hard boundary drops messages. Re-fetching a few is free — `handled()` dedupes.
   */
  since(rewindMs = 120_000) {
    if (!this.watermark) return null;
    return new Date(new Date(this.watermark).getTime() - rewindMs).toISOString();
  }
}
