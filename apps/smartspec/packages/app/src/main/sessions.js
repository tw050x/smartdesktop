// AI sessions: one per connection, told apart by the id the launcher sends with every call. A
// session keeps its window until it ends: the launcher says when it's going, and its heartbeat
// stopping says the same if it crashed. Connections with no id (direct HTTP) share one session,
// which only the user can release.
export const SHARED_SESSION = 'shared';
export const SESSION_TIMEOUT_MS = 60 * 1000;

export function createSessions({ now = Date.now } = {}) {
  const sessions = new Map();

  const alive = (session) => session.id === SHARED_SESSION || now() - session.lastSeen < SESSION_TIMEOUT_MS;

  return {
    // The session for a call, made if it's new; a call shows it's still there.
    touch(id, client) {
      const key = id || SHARED_SESSION;
      let session = sessions.get(key);
      if (!session) {
        session = { id: key, client: client || null, lastSeen: now(), ctx: null };
        sessions.set(key, session);
      }
      if (client) session.client = client;
      session.lastSeen = now();
      return session;
    },
    get: (id) => sessions.get(id),
    alive,

    end(id) {
      const session = sessions.get(id);
      if (!session) return null;
      sessions.delete(id);
      return session;
    },
    // Ends the sessions whose launcher has gone quiet.
    sweep() {
      const gone = [...sessions.values()].filter((session) => !alive(session));
      for (const session of gone) this.end(session.id);
      return gone;
    },
  };
}

// An AI app's name for itself as a person would say it.
const NAMES = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'claude-desktop': 'Claude Desktop' };
export const clientLabel = (client) => NAMES[client] ?? client ?? 'An AI';
