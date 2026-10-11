import { criticalClaims } from '../dist/index.js';
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
export function assessment(template, metadata, delta) {
  return { ...template, chapter: metadata.chapter, contextHash: metadata.contextHash, draftHash: metadata.draftHash, intentHash: metadata.intentHash, reviewed: true,
    critical_checks: delta ? criticalClaims(delta).map(item => ({ claimHash: item.claimHash, verdict: 'supported', evidenceQuote: item.evidenceQuote, explanation: `Hand-authored fixture assertion: ${item.claim}; checked against the quoted test prose.` })) : [],
    ...(template.retrieval_check ? { retrieval_check: { ...template.retrieval_check, notes: 'Fixture uses formal memory and exact prose; the unsupported provider answer is excluded.' } } : {}),
    checks: Object.fromEntries(['evidence', 'coverage', 'continuity'].map(name => [name, { checked: true, notes: [`Fixture ${name} checked against the supplied prose and chapter intent.`] }])) };
}
