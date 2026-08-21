/**
 * Splitting a reply into WhatsApp-sized messages.
 *
 * Twilio's WhatsApp body limit is 1600 characters — far tighter than Telegram's 4096, so
 * an ordinary agent answer splits routinely rather than exceptionally. That makes the
 * split quality matter: a cut through a fenced code block turns the remainder into prose
 * in the reader's client.
 *
 * @module dsh-whatsapp-inbox/chunk
 */

export const WHATSAPP_LIMIT = 1600;

function breakPoint(text, limit) {
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, limit);
    if (at > limit * 0.5) return { cut: at, skip: sep.length };
  }
  return { cut: limit, skip: 0 };
}

/** The language tag of a fence left open at the end of `text`, or null. */
export function openFence(text) {
  const fences = text.match(/^```[^\n]*$/gm);
  if (!fences || fences.length % 2 === 0) return null;
  return fences[fences.length - 1].slice(3).trim();
}

/**
 * Split `text` to fit WhatsApp, reopening an unbalanced code fence across the break.
 * The default leaves headroom under the hard limit for the part counter below.
 */
export function splitMessage(text, limit = 1500) {
  const body = String(text ?? '').trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const chunks = [];
  let rest = body;
  let fence = null;
  while (rest.length > limit) {
    const { cut, skip } = breakPoint(rest, limit);
    let piece = rest.slice(0, cut);
    if (fence !== null) piece = '```' + fence + '\n' + piece;
    const open = openFence(piece);
    if (open !== null) piece += '\n```';
    fence = open;
    chunks.push(piece);
    rest = rest.slice(cut + skip).replace(/^\s+/, '');
  }
  if (rest) chunks.push(fence !== null ? '```' + fence + '\n' + rest : rest);

  // WhatsApp shows no grouping, so several messages arrive as separate bubbles with no
  // hint they belong together. A counter is the cheapest way to make that readable.
  if (chunks.length > 1) {
    return chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`);
  }
  return chunks;
}
