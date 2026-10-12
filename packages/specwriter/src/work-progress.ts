import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { chapterId, hash, readJson, safePath } from './files.js';
import { trustedPrefix } from './memory.js';
import type { Revision, WorkItem } from './types.js';
import type { AuthorGuidance } from './author-guidance.js';

export interface WorkChapterProgress {
  chapter: number;
  acceptedRevision: number | null;
  completed: boolean;
  pending: boolean;
  stage: 'unprepared' | 'prepared' | 'draft' | 'reconcile' | 'accepted';
}

/** Completion belongs to a work's immutable acceptance history, not to all book chapters. */
export function workProgress(root: string, work: WorkItem, current: Revision[], history: Revision[], guidance?: (chapter: number) => AuthorGuidance | undefined): WorkChapterProgress[] {
  const through = trustedPrefix(current).length;
  return Array.from({ length: work.toChapter - work.fromChapter + 1 }, (_, index) => {
    const chapter = work.fromChapter + index;
    const accepted = history.filter(item => item.chapter === chapter && item.workId === work.id).at(-1);
    const directory = `specwriter/work/${work.id}/chapters/${chapterId(chapter)}`;
    const draftPath = safePath(root, `manuscript/drafts/${work.id}/${chapterId(chapter)}.md`);
    const draft = existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : undefined;
    const hasContext = existsSync(safePath(root, directory, 'context.json'));
    // Missing old artifacts are tolerated for migrated books; existing changed artifacts are candidates.
    let pending = !accepted && (hasContext || draft !== undefined);
    if (accepted) {
      const expected = guidance?.(chapter);
      const canonical = current.find(r => r.chapter === chapter);
      if (expected?.instructions.some(instruction => !(instruction.workId === null ? canonical : accepted)?.context.authorGuidance?.instructions.some(saved => isDeepStrictEqual(saved, instruction))) ||
          expected?.feedback.some(directive => !accepted.context.authorGuidance?.feedback.some(saved => isDeepStrictEqual(saved, directive)))) pending = true;
      pending ||= draft !== undefined && hash(draft) !== accepted.bodyHash;
      for (const [name, expected] of [['context.json', accepted.context], ['memory-delta.json', accepted.delta], ['review.json', accepted.review]] as const) {
        const path = safePath(root, directory, name);
        if (!existsSync(path)) continue;
        try { if (!isDeepStrictEqual(readJson(path), expected)) pending = true; }
        catch { pending = true; }
      }
      const intentPath = safePath(root, directory, 'intent.md');
      if (existsSync(intentPath) && accepted.context.intentHash && hash(readFileSync(intentPath, 'utf8')) !== accepted.context.intentHash) pending = true;
      const intentData = safePath(root, directory, 'intent.json');
      if (existsSync(intentData) && accepted.context.workflow) {
        try { if (!isDeepStrictEqual(readJson(intentData), accepted.context.workflow.intent)) pending = true; }
        catch { pending = true; }
      }
    }
    const reconciled = chapter <= through;
    const completed = Boolean(accepted && !pending && reconciled);
    const stage = completed ? 'accepted' : pending ? draft?.trim() ? 'draft' : 'prepared' : accepted && !reconciled ? 'reconcile' : 'unprepared';
    return { chapter, acceptedRevision: accepted?.id ?? null, completed, pending, stage };
  });
}
