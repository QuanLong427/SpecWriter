import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, initProject } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';
export const load = path => JSON.parse(readFileSync(path, 'utf8'));
export function book(t) {
  const directory = mkdtempSync(join(tmpdir(), 'specwriter-boundary-'));
  const root = join(directory, 'book');
  initProject(root, '边界验证', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root); project.propose('arc', '开篇', 1, 3); project.sync();
  t.after(() => { project.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, project };
}
export const fact = (subject, predicate, object, quote) => ({ subject, predicate, object, scope: 'world', holder: null, evidence: { quote, basis: 'established' } });
export const change = (entity, field, old_value, new_value, quote) => ({ entity, field, old_value, new_value, scope: 'world', holder: null, reason: null, evidence: { quote, basis: 'established' } });
export function draft(project, root, chapter, body, changes = {}, options = {}) {
  const prepared = project.prepare(chapter, 'arc', options);
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'arc');
  const delta = extraction({ ...load(paths.delta), ...metadata, title: `第${chapter}章`, summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }], ...changes }, body);
  const review = assessment(load(paths.review), metadata, delta);
  writeFileSync(paths.delta, JSON.stringify(delta)); writeFileSync(paths.review, JSON.stringify(review));
  return { paths, delta, review };
}
