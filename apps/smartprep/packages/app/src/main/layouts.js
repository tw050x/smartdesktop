// Where the user has placed each topic's cards on its board (see renderer/board.js), kept on
// this computer, one file per topic in the app's data folder, as SmartSpec's layouts.js does. It's
// never part of a topic or its cards, and the AI never sees it.

import fs from 'node:fs/promises';
import path from 'node:path';

const safeId = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Not a topic id.');
  return id;
};

export function createLayouts(folder) {
  const fileFor = (topicId) => path.join(folder, `${safeId(topicId)}.json`);
  return {
    async get(topicId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(topicId), 'utf8'));
      } catch {
        return null;
      }
    },
    async save(topicId, layout) {
      const text = JSON.stringify(layout ?? null);
      if (text.length > 1_000_000) throw new Error('That layout is too big to keep.');
      await fs.mkdir(folder, { recursive: true });
      const file = fileFor(topicId);
      await fs.writeFile(`${file}.tmp`, text);
      await fs.rename(`${file}.tmp`, file);
    },
  };
}
