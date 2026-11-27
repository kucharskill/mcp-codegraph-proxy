import { readFileSync } from 'node:fs';
export const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export function log(event) {
  if (process.env.CG_PROXY_DIAGNOSTICS === '1') console.error(JSON.stringify(event));
}
export function milliseconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new Error(`${name} must be an integer from 0 to 2147483647`);
  return value;
}
