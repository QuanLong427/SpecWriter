import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const assetsRoot = fileURLToPath(new URL('../assets/', import.meta.url));
export const schemasRoot = fileURLToPath(new URL('../schemas/', import.meta.url));
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export const chapterId = (chapter: number): string => String(chapter).padStart(4, '0');
export function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}
export function identifier(value: string): string {
  // Portable paths: also avoid Windows device names, trailing dots and separators.
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error('Work id must be a lowercase portable name, e.g. opening-arc');
  }
  return value;
}
export function safePath(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path leaves the project');
  // Existing symlinks/junctions must not redirect project operations outside the root.
  const realBase = existsSync(base) ? realpathSync(base) : base;
  let probe = target;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  if (existsSync(base) && existsSync(probe)) {
    const realRel = relative(realBase, realpathSync(probe));
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error('Project path follows a link outside the project');
  }
  return target;
}
export function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try { writeFileSync(temp, value, 'utf8'); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}
export function writeNew(path: string, value: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
export function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T; }
  catch (error) { throw new Error(`Cannot read JSON ${path}: ${(error as Error).message}`); }
}
