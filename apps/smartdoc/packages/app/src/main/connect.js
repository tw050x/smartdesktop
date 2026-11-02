import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Connecting an AI app to SmartDoc. The app carries the smartdoc command's package (packages/cli,
// copied into the app's resources as cli/), whose MCP launcher AI apps run with the app's own
// executable as Node (ELECTRON_RUN_AS_NODE), so nothing else needs installing; it opens this app
// when the AI first uses it. This works out the setup for each AI app from where the app is now,
// and adds it to Claude Desktop's config file for the user, with the package's agents.js, which
// the smartdoc command's setup uses too.
//
// main.js says where the app is, from Electron (the tests say their own): whether it's packaged,
// its executable, its resources folder, and in development its project folder, data folder and
// MCP port; and the environment. Tests also pass the agents module, and Claude Desktop's config
// file.
export function createConnect({ isPackaged, execPath, resourcesPath, appPath, userData, port, env = process.env, agents = null, claudeConfig = null }) {
  const cli = isPackaged ? path.join(resourcesPath, 'cli') : fileURLToPath(new URL('../../../cli', import.meta.url));
  let loaded = null;
  const load = () => (loaded ??= agents ? Promise.resolve(agents) : import(pathToFileURL(path.join(cli, 'lib', 'agents.js')).href));

  // What AI apps run. In development it's the repository's launcher, opening this project with
  // its own Electron, with the development copy's data folder (where its token is) and port.
  function entry() {
    const launcherEnv = { ELECTRON_RUN_AS_NODE: '1' };
    if (!isPackaged) Object.assign(launcherEnv, { SMARTDOC_APP: appPath, SMARTDOC_USER_DATA: userData, SMARTDOC_PORT: String(port) });
    return { command: execPath, args: [path.join(cli, 'mcp.js')], env: launcherEnv };
  }

  const name = isPackaged ? 'smartdoc' : 'smartdoc-dev';
  const configFile = async () => claudeConfig ?? (await load()).claudeDesktopConfig({ env, allowOverride: !isPackaged });

  return {
    // What the user copies for each AI app.
    async setups() {
      const { claudeCodeCommand, configJson } = await load();
      return { 'claude-code': claudeCodeCommand(entry(), name), config: configJson(entry(), name) };
    },
    async claudeDesktopStatus() {
      return (await load()).claudeDesktopStatus(await configFile(), entry(), name);
    },
    async addToClaudeDesktop() {
      return (await load()).addToClaudeDesktop(await configFile(), entry(), name);
    },
  };
}
