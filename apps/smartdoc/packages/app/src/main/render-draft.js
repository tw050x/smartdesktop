import { BrowserWindow, session } from 'electron';

// Draws a draft's HTML (written by the AI when it applies a review) to a PDF, using the app's own
// Chromium, so the text order in the PDF follows the HTML. The page runs no scripts and can't load
// anything from the network: only inline content and data: URLs.
export async function renderHtmlToPdf(html) {
  const partition = 'draft-render';
  const ses = session.fromPartition(partition);
  if (!ses.__draftRenderGuarded) {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(data|about):/.test(details.url) }));
    ses.__draftRenderGuarded = true;
  }

  const win = new BrowserWindow({
    show: false,
    width: 794, // A4 width at 96 dpi
    height: 1123,
    webPreferences: { partition, javascript: false, sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' }, // the HTML sets its own margins with @page
    });
  } finally {
    win.destroy();
  }
}
