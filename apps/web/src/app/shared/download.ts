import type { BrowserGlobals } from '../device/browser-globals';

/**
 * Hands the user `value` as a JSON file called `fileName` (indented, with a final newline): a Blob
 * behind an object URL, opened by a click on a download link. Throws where the browser cannot
 * make object URLs.
 */
export function downloadJson(
  globals: BrowserGlobals,
  document: Document,
  fileName: string,
  value: unknown,
): void {
  const urls = globals.URL;
  if (urls === undefined) {
    throw new Error('this browser cannot save files (no URL.createObjectURL).');
  }
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const href = urls.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by then; the URL only keeps the Blob in memory.
  setTimeout(() => {
    urls.revokeObjectURL(href);
  }, 60_000);
}
