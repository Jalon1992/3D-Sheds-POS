// Live updates for everyone logged in (Server-Sent Events). Each browser tab keeps one
// connection open; when something changes (new lead, inbound text, contract signed, card moved)
// the server pushes a small event and the open pages refresh just what changed.
import { can } from './permissions.js';

const clients = new Set();

export function streamHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 4000\nevent: hello\ndata: ${JSON.stringify({ user: req.user.id })}\n\n`);
  const c = { res, user: req.user };
  clients.add(c);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

/**
 * Push an event to connected users.
 * @param {string} type    e.g. 'contact', 'message', 'opportunity', 'contract', 'notification'
 * @param {object} data    small payload (ids, a title) — pages re-fetch details themselves
 * @param {object} [to]    { perm, dealer_id, user_id } — who may receive it
 */
export function broadcast(type, data = {}, to = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    const u = c.user;
    if (to.user_id && u.id !== to.user_id && u.role !== 'admin') continue;
    if (to.perm && !can(u, to.perm)) continue;
    // records tied to a lot (or to no lot) are only pushed to lot-limited users of that same lot
    if ('dealer_id' in to && u.dealer_id && u.role !== 'admin' && String(u.dealer_id) !== String(to.dealer_id ?? '')) continue;
    try { c.res.write(msg); } catch { clients.delete(c); }
  }
}
export const connectedCount = () => clients.size;
