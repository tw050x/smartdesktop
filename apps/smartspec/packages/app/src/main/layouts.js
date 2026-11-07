// Where the user has placed each schematic's items in the focus view (see renderer/board.js), kept on
// this computer, one file per schematic in the app's data folder. It's never part of a schematic or
// its drafts, and the AI never sees it.

import fs from 'node:fs/promises';
import path from 'node:path';

const safeId = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Not a schematic id.');
  return id;
};

export function createLayouts(folder) {
  const fileFor = (schemaId) => path.join(folder, `${safeId(schemaId)}.json`);
  return {
    async get(schemaId) {
      try {
        return JSON.parse(await fs.readFile(fileFor(schemaId), 'utf8'));
      } catch {
        return null;
      }
    },
    async save(schemaId, layout) {
      const text = JSON.stringify(layout ?? null);
      if (text.length > 1_000_000) throw new Error('That layout is too big to keep.');
      await fs.mkdir(folder, { recursive: true });
      const file = fileFor(schemaId);
      await fs.writeFile(`${file}.tmp`, text);
      await fs.rename(`${file}.tmp`, file);
    },
  };
}
