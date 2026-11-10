// AI sessions: one per connection, told apart by the id the launcher sends with every call. A
// session keeps its window, and claims what it's working on, so two AIs can't make the same kind
// of change to the same document at once. A claim lasts until the session ends, however long the
// AI waits on the user: the launcher says when it's going, and its heartbeat stopping says the same
// if it crashed. Connections with no id (older launchers, direct HTTP) share one session, which
// only the user can release.
export const LEGACY_SESSION = 'legacy';
export const SESSION_TIMEOUT_MS = 60 * 1000;

export function createSessions({ now = Date.now } = {}) {
  const sessions = new Map();
  const claims = new Map(); // what's claimed → the session id

  const alive = (session) => session.id === LEGACY_SESSION || now() - session.lastSeen < SESSION_TIMEOUT_MS;

  return {
    // The session for a call, made if it's new; a call shows it's still there.
    touch(id, client) {
      const key = id || LEGACY_SESSION;
      let session = sessions.get(key);
      if (!session) {
        session = { id: key, client: client || null, lastSeen: now(), ctx: null, restore: null, docId: null };
        sessions.set(key, session);
      }
      if (client) session.client = client;
      session.lastSeen = now();
      return session;
    },
    get: (id) => sessions.get(id),
    alive,

    // Claims `key` for a session. Gives back the live session holding it instead, if another does.
    claim(session, key) {
      const holder = sessions.get(claims.get(key));
      if (holder && holder !== session && alive(holder)) return holder;
      claims.set(key, session.id);
      return null;
    },
    releaseClaims(session) {
      for (const [key, id] of claims) if (id === session.id) claims.delete(key);
    },
    end(id) {
      const session = sessions.get(id);
      if (!session) return null;
      this.releaseClaims(session);
      sessions.delete(id);
      return session;
    },
    // Ends the sessions whose launcher has gone quiet, giving them back.
    sweep() {
      const gone = [...sessions.values()].filter((session) => !alive(session));
      for (const session of gone) this.end(session.id);
      return gone;
    },
  };
}

// An AI app's name for itself as a person would say it.
const NAMES = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'claude-desktop': 'Claude Desktop', 'smartdoc-chat': 'Claude', 'smartdoc-claude': 'Claude', 'smartdoc-codex': 'ChatGPT' };
export const clientLabel = (client) => NAMES[client] ?? client ?? 'An AI';
