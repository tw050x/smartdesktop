# @smartdesktop/shell

What every SmartDesktop app shares, used by each app as a local dependency
(`"@smartdesktop/shell": "file:../../../../packages/shell"` in its `packages/app/package.json`). It's
private: never published to npm.

- `main/`: for the main process (Electron's), such as `tab-drag.js`. Imports nothing from outside
  `main/`, as an app's own main process doesn't (its test checks).
- `renderer/`: for the windows' pages, bundled into each app by Vite, such as `rubber-band.js`.

Import a file by its path: `import { createTabDrag } from '@smartdesktop/shell/main/tab-drag.js'`.
`npm test` here runs its own tests.
