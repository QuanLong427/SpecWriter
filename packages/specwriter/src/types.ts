// ChapterDelta adapts ainovel-cli's Apache-2.0 chapter-facts contract.
// Modified: provenance, draft/context identity, temporal and belief scopes.
// See ../THIRD_PARTY_NOTICES.md and ../licenses/ainovel-cli-Apache-2.0.txt.
export interface Evidence { quote: string; basis?: 'established' | 'reported' | 'inferred' | 'imagined'; start?: number; end?: number }
export interface ScopedFact {
  subject: string;
  predicate: string;
  object: string;
  scope: 'world' | 'belief';
  holder: string | null;
  evidence: Evidence;
}
export interface EntityInput {
  id: string;
  name: string;
  type: 'character' | 'location' | 'item' | 'faction' | 'concept';
  aliases: string[];
  description: string;
  evidence: Evidence;
}
export interface NarrativeEventInput {
  id: string;
  description: string;
  story_time: string | null;
  participants: string[];
  location: string | null;
  causes: string[];
  scope: 'world' | 'belief';
  holder: string | null;
  evidence: Evidence;
}
export interface ResourceChange {
  entity: string;
  resource: string;
  opening: number;
  change: number;
  closing: number;
  evidence: Evidence;
}
export interface ChapterDelta {
  schemaVersion: 1 | 2;
  chapter: number;
  baseRevision: number | null;
  contextHash: string;
  draftHash: string;
  intentHash?: string;
  title: string;
  summary: string;
  characters: string[];
  key_events: { description: string; evidence: Evidence }[];
  timeline_events: { time: string; event: string; characters: string[]; evidence: Evidence }[];
  foreshadow_updates: { id: string; action: 'plant' | 'advance' | 'resolve' | 'defer' | 'supersede'; description: string | null; expected_payoff?: string; depends_on?: string[]; superseded_by?: string | null; evidence: Evidence }[];
  relationship_changes: { character_a: string; character_b: string; relation: string; evidence: Evidence }[];
  state_changes: { entity: string; field: string; old_value: string | null; new_value: string; reason: string | null; scope: 'world' | 'belief'; holder: string | null; evidence: Evidence }[];
  cast_intros: { name: string; brief_role: string; evidence: Evidence }[];
  facts: ScopedFact[];
  entities?: EntityInput[];
  narrative_events?: NarrativeEventInput[];
  resource_changes?: ResourceChange[];
}
export interface ChapterReview {
  schemaVersion: 1 | 2;
  chapter: number;
  contextHash: string;
  draftHash: string;
  intentHash?: string;
  checks?: Record<'evidence' | 'coverage' | 'continuity', { checked: boolean; notes: string[] }>;
  reviewed: boolean;
  issues: { id: string; kind: 'continuity' | 'spec' | 'craft'; severity: 'blocking' | 'warning' | 'suggestion'; description: string; resolved: boolean; resolution?: string }[];
  notes: string[];
  critical_checks?: { claimHash: string; verdict: 'supported' | 'unsupported' | 'uncertain'; evidenceQuote: string; explanation: string }[];
  intent_checks?: { id: string; verdict: 'satisfied' | 'uncertain' | 'violated'; evidenceQuotes: string[]; explanation: string }[];
  retrieval_check?: { assessmentHash: string; decision: 'use-formal-memory'; notes: string };
}
export interface Revision {
  id: number;
  chapter: number;
  body: string;
  bodyHash: string;
  delta: ChapterDelta;
  review: ChapterReview;
  context: ContextPackage;
  workId: string;
  acceptedAt: string;
  stale: boolean;
}
export interface MemoryFact extends ScopedFact {
  id: string;
  sourceChapter: number;
  sourceRevision: number;
  validFromChapter: number;
  validUntilChapter: number | null;
  evidenceLine: number;
}
export interface MemoryHook {
  id: string;
  description: string;
  status: 'open' | 'progressing' | 'resolved' | 'deferred' | 'superseded';
  startChapter: number;
  sourceChapter: number;
  sourceRevision: number;
  evidence: Evidence;
  expectedPayoff?: string;
  dependsOn?: string[];
  supersededBy?: string | null;
}
export interface Provenance { sourceChapter: number; sourceRevision: number; evidence: Evidence; evidenceLine: number }
export interface MemoryEntity extends EntityInput, Provenance {}
export interface MemoryEpisode extends NarrativeEventInput, Provenance { kind: 'key-event' | 'narrative-event' }
export interface MemoryResource extends Provenance { entity: string; resource: string; amount: number }
export interface MemoryState {
  atChapter: number;
  facts: MemoryFact[];
  hooks: MemoryHook[];
  timeline: { time: string; event: string; characters: string[]; evidence: Evidence; sourceChapter: number; sourceRevision: number }[];
  summaries: { chapter: number; revision: number; title: string; summary: string; characters: string[] }[];
  entities: MemoryEntity[];
  episodes: MemoryEpisode[];
  resources: MemoryResource[];
}
export interface ContextSource {
  id: string;
  kind: 'spec' | 'plan' | 'proposal' | 'intent' | 'prose' | 'retrieval';
  source: string;
  reason: string;
  content: string;
  hash: string;
  chapter?: number;
  revision?: number;
  protection: 'protected' | 'compressible';
}
export interface AdoptedContract {
  id: number; fromChapter: number; reason: string; adoptedAt: string;
  sources: { name: string; source: string; content: string; hash: string }[];
}
export interface ChapterIntent {
  schemaVersion: 1; chapter: number; goal: string; scenes: string[];
  participantIds: string[]; newEntities: { id: string; name: string; type: EntityInput['type'] }[];
  pov: string | null; storyTime: string | null;
  requiredState: { entity: string; fields: string[] }[];
  requiredResources: { entity: string; resource: string }[];
  requiredEvents: string[]; requiredHooks: string[];
  knowledgeChecks: { holder: string; topic: string }[];
  withhold: string[]; expectedChanges: string[]; targetChars: number | null; planPaths: string[];
}
export interface WorkPolicy {
  schemaVersion: 1; workId: string; fromChapter: number; toChapter: number;
  acceptance: 'draft' | 'auto'; reason: string; paused: boolean; pauseReason: string | null;
  controlReason?: string;
}
export interface ContextRequirements {
  factIds: string[]; entityIds: string[]; eventIds: string[]; hookIds: string[];
  resourceKeys: string[]; knowledgeGaps: string[];
}
export interface ContextPackage {
  schemaVersion: 1;
  contractVersion?: 2;
  reviewPolicyVersion?: 1;
  intentHash?: string;
  chapter: number;
  workId: string;
  baseRevision: number | null;
  generation: number;
  inputFingerprint: string;
  query: string;
  budgetChars: number;
  selectedChars: number;
  memory: MemoryState;
  memorySelection: { strategy: 'query-recent-one-hop' | 'hybrid-graphrag' | 'microsoft-graphrag'; totalActiveFacts: number; selectedFacts: number; totalHooks: number; selectedHooks: number; totalEpisodes?: number; selectedEpisodes?: number };
  retrieval?: { engine: 'writer-memory-graphrag' | 'microsoft-graphrag'; snapshotId: string; hops: number; seedIds: string[]; paths: GraphPath[]; status?: 'empty' | 'ready'; method?: GraphRagMethod; receiptId?: string; answerHash?: string; configHash?: string; outputHash?: string; answerTruncated?: boolean; assessment?: RetrievalAssessment };
  sources: ContextSource[];
  contextHash: string;
  workflow?: { version: 1; contractId: number; intentDataHash: string; intent: ChapterIntent; requirements: ContextRequirements };
}
export interface WorkItem {
  id: string;
  title: string;
  fromChapter: number;
  toChapter: number;
  status: 'active' | 'archived';
}
export interface BookConfig {
  schemaVersion: 1;
  bookId?: string;
  name: string;
  language: 'zh' | 'en';
  contextBudgetChars: number;
  workflow?: 'structured' | 'legacy';
  versioning?: { enabled: boolean; autoSave: boolean };
  memory?: { backend: 'microsoft-graphrag' | 'local'; method?: GraphRagMethod; autoIndex?: boolean; indexRetention?: number };
}
export type GraphRagMethod = 'local' | 'global' | 'drift' | 'basic';
export interface RetrievalReceipt {
  schemaVersion: 1; id: string; provider: 'microsoft-graphrag'; version: string;
  snapshotId: string; atChapter: number; method: GraphRagMethod; query: string;
  configHash: string; outputHash: string; answer: string; answerHash: string;
  sources?: RetrievalSource[];
  unresolvedCitations?: { citationType: string; citationId: string }[];
}
export interface RetrievalSource { citationType: string; citationId: string; chapter: number; revision: number; bodyHash: string; excerpt: string }
export interface RetrievalAssessment {
  policyVersion: 1; status: 'supported' | 'needs-review' | 'conflicting'; evidenceStatus: 'verified' | 'partial' | 'missing';
  accepted: boolean; assessmentHash: string; warnings: string[]; analysisTruncated: boolean; checkedCharacters: number;
  conflicts: { subject: string; field: string; expected: string; observed: string; sourceChapter: number; sourceRevision: number; quote: string; answerExcerpt: string }[];
}
export interface GraphNode extends Partial<Provenance> {
  id: string;
  kind: 'entity' | 'value' | 'event' | 'hook' | 'resource';
  label: string;
  aliases: string[];
  description: string;
  recordId?: string;
  entityType?: EntityInput['type'];
  scope?: 'world' | 'belief';
  holder?: string | null;
}
export interface GraphEdge extends Provenance {
  id: string;
  from: string;
  to: string;
  relation: string;
  kind: 'fact' | 'participant' | 'location' | 'causal' | 'dependency' | 'resource';
  scope: 'world' | 'belief';
  holder: string | null;
  factId?: string;
  recordId?: string;
}
export interface GraphSnapshot {
  schemaVersion: 1;
  kernelVersion: 1 | 2 | 3;
  snapshotId: string;
  atChapter: number;
  sourceRevisions: { chapter: number; revision: number; bodyHash: string; deltaHash: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphPath { nodeIds: string[]; edgeIds: string[] }
export interface GraphRetrieval {
  engine: 'writer-memory-graphrag';
  snapshotId: string;
  atChapter: number;
  hops: number;
  seedIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: GraphPath[];
  truncated: boolean;
}
