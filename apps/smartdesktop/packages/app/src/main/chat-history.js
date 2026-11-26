// The chat history (the user's choice: a closed chat's tab couldn't be had back): every chat kept,
// as the history panel lists it (chat.js), most recently used first, grouped by when, and searched
// by name and by what was said. No Electron here, so it can be tested; the renderer imports it too.

const PREVIEW = 140; // characters of a chat's last message shown under its name
const AROUND = 40; // characters before a match shown, in a search's snippet

const said = (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim();
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const cut = (text, length) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

// What the panel shows of a chat: its name, when it was last used (its last message, else when it
// was made), the AI last talked to, the last thing said in it (`You: ` before the user's), and
// whether anything was said in it at all (`said`: one that was only ever opened isn't history).
export function summarize(chat) {
  const messages = chat.messages ?? [];
  const last = messages.findLast(said);
  const usedAt = messages.findLast((m) => m.at)?.at ?? chat.createdAt ?? null;
  return {
    id: chat.id,
    title: chat.title || 'New chat',
    createdAt: chat.createdAt ?? null,
    usedAt,
    by: last?.by ?? null,
    preview: last ? cut(`${last.role === 'user' ? 'You: ' : ''}${oneLine(last.text)}`, PREVIEW) : '',
    said: Boolean(last),
  };
}

// A chat as a search finds it: by its name, or by anything the user or the AI said in it (not the
// lines of context, nor the steps). Each word searched for must be there, in any case; the preview
// is then where the first word was found in what was said, if it wasn't in the name. Null if not.
export function search(chat, query) {
  const words = oneLine(query).toLowerCase().split(' ').filter(Boolean);
  const summary = summarize(chat);
  if (!words.length) return summary;
  const title = summary.title.toLowerCase();
  const texts = (chat.messages ?? []).filter(said);
  const all = `${title}\n${texts.map((m) => m.text.toLowerCase()).join('\n')}`;
  if (!words.every((w) => all.includes(w))) return null;
  if (words.some((w) => title.includes(w))) return summary;
  for (const m of texts.toReversed()) {
    const text = oneLine(m.text);
    const at = text.toLowerCase().indexOf(words[0]);
    if (at < 0) continue;
    // (From the start of a word.)
    let start = Math.max(0, at - AROUND);
    if (start) start = Math.min(at, text.indexOf(' ', start) + 1 || at);
    const snippet = `${start ? '…' : ''}${text.slice(start)}`;
    return { ...summary, preview: cut(`${m.role === 'user' ? 'You: ' : ''}${snippet}`, PREVIEW), match: true };
  }
  return summary;
}

// Newest first.
export const byUse = (a, b) => String(b.usedAt ?? '').localeCompare(String(a.usedAt ?? ''));

// Which group a chat last used at `at` goes in, seen at `now`: Today, Yesterday, Previous 7 Days,
// Previous 30 Days, then its month ("October", or "October 2025" in another year).
export function period(at, now = new Date()) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return 'Earlier';
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 Days';
  if (days < 30) return 'Previous 30 Days';
  const month = when.toLocaleString(undefined, { month: 'long' });
  return when.getFullYear() === now.getFullYear() ? month : `${month} ${when.getFullYear()}`;
}

// When, beside a chat's name: the time today, the weekday this week, else the date.
export function when(at, now = new Date()) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const group = period(at, now);
  if (group === 'Today') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (group === 'Yesterday') return 'Yesterday';
  if (group === 'Previous 7 Days') return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
