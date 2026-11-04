/**
 * A short, readable name for a browser from its User-Agent, for the signed-in
 * devices list: "Chrome on Android", "Safari on iPhone". Only a label: a
 * client can send any User-Agent, so nothing is decided by it. Order matters,
 * since most browsers' strings also name Safari, and Chromium-based ones
 * name Chrome.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const first = (ua: string, table: [RegExp, string][]): string | null => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 500);
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `A browser on ${system}`;
  return 'Unknown browser';
}
