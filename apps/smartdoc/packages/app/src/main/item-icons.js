// Each document's icon (see icons.js), kept on this Mac in item-icons.json beside the documents:
// { [document id]: { icon, by } }, `by` 'user' or 'ai'. The AI gives a document one when it has none
// (set_icon); the user's own choice is never replaced by the AI's. Not part of the document or its
// drafts.
import fs from 'node:fs';
import path from 'node:path';
import { isIcon } from './icons.js';

export function createItemIcons(userData, { onChange = () => {} } = {}) {
  const file = path.join(userData, 'item-icons.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  };
  return {
    get: (id) => all[id] ?? null,
    // Sets an icon, by the user or the AI. The AI's never replaces the user's: it's told so.
    set(id, icon, by) {
      if (!isIcon(icon)) throw new Error(`There's no icon called "${icon}".`);
      if (by === 'ai' && all[id]?.by === 'user') return { icon: all[id].icon, kept: true };
      all[id] = { icon, by };
      save();
      onChange(id);
      return { icon, kept: false };
    },
  };
}
