import { readdirSync } from 'node:fs';
import { assetsRoot, atomicWrite, identifier, json, readJson, safePath } from './files.js';
import type { ResearchLibrary } from './research.js';

export interface CraftProfile {
  schemaVersion: 1; id: string; title: string; description: string;
  principles: string[]; sceneQuestions: string[]; reviewQuestions: string[]; pitfalls: string[];
}
const fields = ['principles', 'sceneQuestions', 'reviewQuestions', 'pitfalls'] as const;
export function craftProfile(id: string): CraftProfile {
  const profile = readJson<CraftProfile>(safePath(assetsRoot, 'craft', `${identifier(id)}.json`));
  if (profile.schemaVersion !== 1 || profile.id !== id || typeof profile.title !== 'string' || !profile.title.trim() ||
      typeof profile.description !== 'string' || !profile.description.trim() || fields.some(field => !Array.isArray(profile[field]) ||
        !profile[field].length || profile[field].length > 30 || profile[field].some(item => typeof item !== 'string' || !item.trim() || item.length > 2000))) throw new Error(`Invalid craft profile: ${id}`);
  return profile;
}
export function craftProfiles() {
  return readdirSync(safePath(assetsRoot, 'craft'), { withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.json'))
    .map(item => craftProfile(item.name.slice(0, -5))).sort((a, b) => a.id.localeCompare(b.id)).map(({ id, title, description }) => ({ id, title, description }));
}
/** Creates reference material only; author adoption still belongs to Specs/instructions. */
export function useCraftProfile(library: ResearchLibrary, profileId: string, reportId: string) {
  const profile = craftProfile(profileId);
  const path = library.create(reportId, { kind: 'craft', title: profile.title, question: '如何将这份写作方法适配当前作者、作品和章节？' });
  library.capture(reportId, { sourceId: 'method', title: profile.title, kind: 'builtin', content: json(profile),
    metadata: { profileId: profile.id, evidenceType: 'original-craft-guidance', marketEvidence: false } });
  const report = library.draft(reportId);
  // Source content uses JSON escapes, so quote a stable literal representation of each principle.
  report.observations = profile.principles.map(text => ({ text, evidence: [{ sourceId: 'method', quote: JSON.stringify(text) }] }));
  report.interpretations = [
    ...profile.sceneQuestions.map(text => ({ text: `场景自查：${text}`, sourceIds: ['method'] })),
    ...profile.reviewQuestions.map(text => ({ text: `审阅问题：${text}`, sourceIds: ['method'] })),
    ...profile.pitfalls.map(text => ({ text: `常见陷阱：${text}`, sourceIds: ['method'] }))
  ];
  report.unknowns = ['这是原创写作经验，不是当前平台榜单或市场实证；适用规则由作者选择。'];
  atomicWrite(path, json(report));
  return library.save(reportId);
}
