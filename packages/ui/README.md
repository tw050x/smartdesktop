# @smartdesktop/ui

The interface every SmartDesktop app shares: the windows of tabs and their top bar, and the
components the apps reuse (the tooltips, the icons, rubber banding…). Each app uses it as a local
dependency (`"@smartdesktop/ui": "file:../../../../packages/ui"` in its `packages/app/package.json`).
It's private: never published to npm.

- `main/`: for the main process (Electron's), or for both processes where it touches neither the
  DOM nor Node, such as `tab-drag.js` and `icons.js`. Imports nothing from outside `main/`, as an
  app's own main process doesn't (its test checks).
- `renderer/`: for the windows' pages, bundled into each app by Vite, such as `tooltips.js` and
  `rubber-band.js`.

A component comes here once it's the same in the apps that have it, or can be made the same with
an option for what differs. Import a file by its path:
`import { createTabDrag } from '@smartdesktop/ui/main/tab-drag.js'`. `npm test` here runs its own
tests.
