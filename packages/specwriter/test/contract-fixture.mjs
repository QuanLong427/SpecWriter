// These deterministic fixture assessments stand in for a Codex extraction/review.
export function extraction(input, body) {
  const value = structuredClone(input);
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (item.evidence) {
      item.evidence.basis ??= 'established';
      if (body.indexOf(item.evidence.quote) !== body.lastIndexOf(item.evidence.quote)) {
        item.evidence.start ??= body.indexOf(item.evidence.quote);
        item.evidence.end ??= item.evidence.start + item.evidence.quote.length;
      }
    }
    for (const child of Object.values(item)) if (typeof child === 'object') visit(child);
  };
  visit(value); return value;
}
export function assessment(template, metadata) {
  return { ...template, chapter: metadata.chapter, contextHash: metadata.contextHash, draftHash: metadata.draftHash, intentHash: metadata.intentHash, reviewed: true,
    checks: Object.fromEntries(['evidence', 'coverage', 'continuity'].map(name => [name, { checked: true, notes: [`Fixture ${name} checked against the supplied prose and chapter intent.`] }])) };
}
