// Which of SmartDesktop's windows are on the Space the user is on, so a chat asked for from an app
// goes to the chat window there (the user's choice: a chat window for each Space). Electron can't
// say, so macOS's own window list is asked (CGWindowListCopyWindowInfo, on screen only: windows on
// other Spaces, and hidden ones, aren't in it) through JavaScript for Automation, which needs no
// permission for window numbers; a window's number is in its media source id ("window:<n>:0"). It
// takes about a tenth of a second. Anywhere else, or if it fails, no window is known to be there.
import { execFile } from 'node:child_process';

const SCRIPT = `ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
  return JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === pid).map((w) => w.kCGWindowNumber));
}`;

export function windowsOnThisSpace() {
  if (process.platform !== 'darwin') return Promise.resolve(new Set());
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, String(process.pid)], { timeout: 2000 }, (error, stdout) => {
      try {
        resolve(error ? new Set() : new Set(JSON.parse(stdout)));
      } catch {
        resolve(new Set());
      }
    });
  });
}

// A BrowserWindow's number in macOS's window list.
export function windowNumber(win) {
  const match = /^window:(\d+):/.exec(win.getMediaSourceId?.() ?? '');
  return match ? Number(match[1]) : null;
}
