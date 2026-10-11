import { Ajv } from 'ajv';
import { join } from 'node:path';
import { readJson, schemasRoot } from './files.js';
import type { ChapterDelta, ChapterIntent, ChapterReview } from './types.js';
import { subjectiveOnly } from './memory-policy.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const deltaValidator = ajv.compile(readJson(join(schemasRoot, 'chapter-delta.schema.json')));
const reviewValidator = ajv.compile(readJson(join(schemasRoot, 'review.schema.json')));
const intentValidator = ajv.compile(readJson(join(schemasRoot, 'chapter-intent.schema.json')));
export function validateIntent(value: unknown): asserts value is ChapterIntent {
  if (!intentValidator(value)) throw new Error(`Invalid chapter intent: ${ajv.errorsText(intentValidator.errors)}`);
  const intent = value as ChapterIntent;
  if (new Set(intent.newEntities.map(item => item.id)).size !== intent.newEntities.length) throw new Error('Duplicate planned entity ids');
  if (new Set(intent.newEntities.map(item => item.name.normalize('NFKC').trim().toLowerCase())).size !== intent.newEntities.length) throw new Error('Duplicate planned entity names');
  if (intent.pov !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(intent.pov)) throw new Error('Intent POV must be a stable entity id or null');
  if (intent.storyTime !== null && !intent.storyTime.trim()) throw new Error('Intent storyTime must be nonempty or null');
  for (const path of intent.planPaths) if (!/^specwriter\/plans\/(?:[a-zA-Z0-9_\-\u4e00-\u9fff]+\/)*[a-zA-Z0-9_\-\u4e00-\u9fff]+\.md$/.test(path)) throw new Error('Intent planPaths must name Markdown files inside specwriter/plans');
}
export function validateDelta(value: unknown, body: string): asserts value is ChapterDelta {
  if (!deltaValidator(value)) throw new Error(`Invalid memory delta: ${ajv.errorsText(deltaValidator.errors)}`);
  const delta = value as ChapterDelta;
  for (const item of [...delta.facts, ...delta.state_changes]) {
    const claim = 'object' in item ? item.object : item.new_value;
    if (delta.schemaVersion === 2 && item.scope === 'world' && subjectiveOnly(item.evidence.quote) && !subjectiveOnly(claim)) throw new Error('Subjective-only evidence cannot establish a world state/fact; use belief or a precise establishing passage');
  }
  for (const collection of [delta.key_events, delta.timeline_events, delta.foreshadow_updates, delta.relationship_changes, delta.state_changes, delta.cast_intros, delta.facts, delta.entities ?? [], delta.narrative_events ?? [], delta.resource_changes ?? []]) {
    for (const item of collection) {
      if (!body.includes(item.evidence.quote)) throw new Error(`Evidence quote does not occur in draft: ${item.evidence.quote.slice(0, 80)}`);
      const evidence = item.evidence;
      if (evidence.start !== undefined && (evidence.end! < evidence.start || body.slice(evidence.start, evidence.end) !== evidence.quote || evidence.end! > body.length)) throw new Error('Evidence quote does not match its exact offsets');
      if (delta.schemaVersion === 2 && !evidence.basis) throw new Error('V2 evidence requires basis: established, reported, inferred or imagined');
      if (delta.schemaVersion === 2 && evidence.start === undefined && body.indexOf(evidence.quote) !== body.lastIndexOf(evidence.quote)) throw new Error('Repeated evidence quote requires exact start/end offsets');
      if (delta.schemaVersion === 2 && 'scope' in item && item.scope === 'world' && evidence.basis !== 'established') throw new Error('Reported, inferred or imagined evidence cannot establish a world fact/event; use belief scope or find establishing prose');
      if (delta.schemaVersion === 2 && !('scope' in item) && evidence.basis !== 'established') throw new Error('Unscoped memory updates require established evidence; do not promote reports, inference or dreams to formal state');
    }
  }
  const unique = (items: string[], name: string): void => {
    if (new Set(items).size !== items.length) throw new Error(`Duplicate ${name}`);
  };
  unique(delta.foreshadow_updates.map(item => item.id), 'hook operations');
  unique(delta.state_changes.map(item => JSON.stringify([item.scope, item.holder, item.entity, item.field])), 'state operations');
  unique(delta.facts.map(item => JSON.stringify([item.scope, item.holder, item.subject, item.predicate, item.object])), 'facts');
  unique((delta.entities ?? []).map(item => item.id), 'entity ids');
  unique((delta.narrative_events ?? []).map(item => item.id), 'event ids');
  unique((delta.resource_changes ?? []).map(item => JSON.stringify([item.entity, item.resource])), 'resource operations');
  for (const update of delta.foreshadow_updates) {
    if (update.action === 'supersede' && !update.superseded_by?.trim()) throw new Error(`Supersede requires a replacement hook id: ${update.id}`);
    if (update.action !== 'supersede' && update.superseded_by != null) throw new Error('Only supersede can set superseded_by');
  }
  for (const item of [...delta.facts, ...delta.state_changes, ...(delta.narrative_events ?? [])]) {
    if (item.scope === 'world' && item.holder !== null) throw new Error('World facts require holder: null');
    if (item.scope === 'belief' && !item.holder?.trim()) throw new Error('Beliefs require the name of the character who holds them');
  }
  for (const resource of delta.resource_changes ?? []) {
    if (Math.abs(resource.opening + resource.change - resource.closing) > 1e-9 * Math.max(1, Math.abs(resource.closing))) throw new Error(`Resource arithmetic does not reconcile: ${resource.entity}.${resource.resource}`);
  }
  for (const relation of delta.relationship_changes) {
    if (relation.character_a === relation.character_b) throw new Error('A relationship requires two different characters');
  }
}
export function validateReview(value: unknown): asserts value is ChapterReview {
  if (!reviewValidator(value)) throw new Error(`Invalid review: ${ajv.errorsText(reviewValidator.errors)}`);
  const review = value as ChapterReview;
  if (!review.reviewed) throw new Error('Review has not been performed');
  if (review.schemaVersion === 2) for (const [name, check] of Object.entries(review.checks!)) {
    if (!check.checked || !check.notes.length) throw new Error(`Review check ${name} requires a completed, evidence-based assessment`);
  }
  if (new Set(review.issues.map(item => item.id)).size !== review.issues.length) throw new Error('Duplicate review issue ids');
  for (const issue of review.issues) {
    if (issue.severity === 'blocking' && !issue.resolved) throw new Error(`Unresolved blocking review issue: ${issue.id}`);
    if (issue.resolved && !issue.resolution?.trim()) throw new Error(`Resolved review issue needs a resolution: ${issue.id}`);
  }
}
