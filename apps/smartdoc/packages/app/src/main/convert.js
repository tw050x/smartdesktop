// Other files as PDFs, for the experimental Open Word, Excel and PowerPoint files (Settings ›
// Experimental): Word, Excel and PowerPoint files, Markdown, plain text and pictures, turned into a
// PDF by @smartdoc/pdf (packages/pdf; copied into the app's resources when packaged) with no other
// program. It takes milliseconds for an ordinary document, so it runs here, in the main process.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

let converter = null;
async function load() {
  if (!converter) {
    const dir = app.isPackaged ? path.join(process.resourcesPath, 'pdf') : path.join(here, '../../../pdf');
    converter = await import(pathToFileURL(path.join(dir, 'index.js')).href);
  }
  return converter;
}

// The kinds converted, and what each is called to the user.
export const CONVERTED = { docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation', markdown: 'Markdown file', text: 'text file', png: 'PNG picture', jpeg: 'JPEG picture' };
// The file types offered in the open panel when converting is on.
export const EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg'];

// What a file is: 'pdf', one of CONVERTED's kinds, or another (with the refusal to show for it,
// for older Office files, or null).
export async function inspect(filePath) {
  const bytes = await readFile(filePath);
  const { detect, REFUSED } = await load();
  const kind = detect(bytes, path.basename(filePath));
  return { kind, bytes, refusal: REFUSED[kind] ?? null };
}

// A file turned into a PDF: { pdf, kind, report, notes }. The report says what wasn't shown as it
// is (fonts stood in for, things not drawn yet); `notes` says it to the user, a sentence a line, or
// is null when everything showed as it is.
export async function convertFile(filePath, bytes = null) {
  const { convert, describeReport } = await load();
  const data = bytes ?? (await readFile(filePath));
  const { pdf, kind, report } = await convert(data, { name: path.basename(filePath) });
  return { pdf: Buffer.from(pdf), kind, report, notes: describeReport(report) };
}
