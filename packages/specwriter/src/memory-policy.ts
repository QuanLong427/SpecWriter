import { hash, json } from './files.js';
import { resolveEntityReference } from './entity-reference.js';
import type { ChapterDelta, ChapterReview, MemoryState, RetrievalAssessment, RetrievalReceipt } from './types.js';

const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
const fields = [
  ['位置', 'location', '位置', '当前位置', '所在地', '所在地点'],
  ['生死', 'life', 'alive', '生死', '生死状态', '存活状态'],
  ['境界', 'realm', '境界', '修炼境界', '修为境界'],
  ['真实身份', 'identity', '真实身份', '真正身份']
];
export function stateField(field: string, value = ''): string | undefined {
  const key = normalize(field);
  if (['状态', 'status'].includes(key) && /^(活着|存活|健在|alive|已死|死亡|死了|dead|deceased)$/i.test(value.trim())) return '生死';
  return fields.find(group => group.slice(1).some(alias => normalize(alias) === key))?.[0];
}
export function stateValue(field: string, value: string): string {
  if (stateField(field, value) === '生死') {
    if (/^(活着|存活|健在|alive)$/i.test(value.trim())) return '活着';
    if (/^(已死|死亡|死了|dead|deceased)$/i.test(value.trim())) return '死亡';
  }
  return value.trim();
}
export interface ClaimRequirement { claimHash: string; category: string; claim: string; evidenceQuote: string }
export function criticalClaims(delta: ChapterDelta): ClaimRequirement[] {
  const result: ClaimRequirement[] = [];
  const add = (category: string, item: { evidence: { quote: string } }, claim: string) => result.push({ claimHash: hash(json({ category, item })), category, claim, evidenceQuote: item.evidence.quote });
  for (const item of delta.facts) if (item.scope === 'world') add('fact', item, `${item.subject} / ${item.predicate}：${item.object}`);
  for (const item of delta.state_changes) if (item.scope === 'world') add('state', item, `${item.entity} / ${item.field}：${item.old_value ?? '未记录'} → ${item.new_value}`);
  for (const item of delta.resource_changes ?? []) add('resource', item, `${item.entity} / ${item.resource}：${item.opening} → ${item.closing}`);
  for (const item of delta.entities ?? []) add('entity', item, `${item.id}：${item.name}；${item.description}`);
  for (const item of delta.narrative_events ?? []) if (item.scope === 'world') add('event', item, item.description);
  for (const item of delta.key_events) add('key-event', item, item.description);
  for (const item of delta.timeline_events) add('timeline', item, `${item.time}：${item.event}`);
  for (const item of delta.relationship_changes) add('relationship', item, `${item.character_a} / ${item.character_b}：${item.relation}`);
  for (const item of delta.cast_intros) add('cast', item, `${item.name}：${item.brief_role}`);
  for (const item of delta.foreshadow_updates) add('hook', item, `${item.id}：${item.action}`);
  return result;
}
// This deliberately narrow guard catches unsupported promotions of an explicitly
// subjective passage; it is not a general Chinese entailment classifier.
export function subjectiveOnly(quote: string): boolean {
  return /以为|误以为|据说|传闻|听说|猜测|猜想|梦见|梦到|想象|或许|可能/.test(quote)
    && !/其实|实际上|事实上|实则|真实情况|然而|但实际上|却发现/.test(quote);
}
export function reviewCriticalClaims(delta: ChapterDelta, review: ChapterReview): void {
  const required = criticalClaims(delta);
  const checks = review.critical_checks ?? [];
  if (new Set(checks.map(check => check.claimHash)).size !== checks.length) throw new Error('Duplicate critical claim reviews');
  const expected = new Set(required.map(item => item.claimHash));
  if (checks.some(check => !expected.has(check.claimHash))) throw new Error('Critical review refers to an outdated or unknown claim; re-review extraction');
  for (const item of required) {
    const check = checks.find(check => check.claimHash === item.claimHash);
    if (!check || check.verdict !== 'supported' || check.evidenceQuote !== item.evidenceQuote || !check.explanation.trim()) throw new Error(`Critical claim requires a supported, evidence-specific review: ${item.claim}`);
  }
}

export function assessRetrieval(receipt: RetrievalReceipt, state: MemoryState): RetrievalAssessment {
  const sources = receipt.sources ?? [], unresolved = receipt.unresolvedCitations ?? [];
  const evidenceStatus = !sources.length ? 'missing' : unresolved.length ? 'partial' : 'verified';
  const warnings: string[] = [], conflicts: RetrievalAssessment['conflicts'] = [];
  if (evidenceStatus !== 'verified') warnings.push(evidenceStatus === 'missing' ? '检索回答没有可核对的原文引用，不能直接用于确立剧情事实。' : '部分检索引用无法映射到原文，须核对后使用。');
  const analysisTruncated = receipt.answer.length > 60000;
  if (analysisTruncated) warnings.push('回答超过自动核对的 60000 字符上限；剩余内容未核对，不能直接采用完整回答。');
  const clauses = receipt.answer.slice(0, 60000).replace(/\[Data:[^\]]*\]/gi, '').replace(/[*_`#]/g, '').split(/[。！？；\n，]/).map(s => s.trim()).filter(Boolean);
  const active = state.facts.filter(f => f.validUntilChapter === null && f.scope === 'world' && stateField(f.predicate, f.object));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const fact of active) {
    const entity = state.entities.find(e => e.id === resolveEntityReference(state, fact.subject, false));
    const names = [...new Set([fact.subject, ...(entity ? [entity.name, ...entity.aliases] : [])])];
    const field = stateField(fact.predicate, fact.object)!;
    for (const clause of clauses) {
      if (!names.some(name => clause.includes(name))) continue;
      if (subjectiveOnly(clause) || /曾经|此前|过去|最初|当时|之前|第\s*\d+\s*章/.test(clause)) continue;
      let observed: string | undefined;
      for (const name of names) {
        if (field === '位置') observed ??= new RegExp(`${esc(name)}(?:现在|目前|当前|仍然|仍|正|已经)?(?:位于|身处|的位置(?:是|为)|在)([^，。！？；\\n]+)`).exec(clause)?.[1]?.trim();
        else if (field === '生死') {
          const match = new RegExp(`${esc(name)}(?:现在|目前|当前|已经|已|仍然|仍|还)?(?:是|处于)?(活着|存活|健在|死亡|已死|死了|alive|dead)`, 'i').exec(clause);
          if (match) observed = stateValue(field, match[1]!);
        } else observed ??= new RegExp(`${esc(name)}(?:现在|目前|当前)?(?:的)?(?:${field}|${field === '境界' ? '修炼境界' : '真正身份'})(?:是|为|：|:)([^，。！？；\\n]+)`).exec(clause)?.[1]?.trim();
      }
      if (!observed) continue;
      const expected = stateValue(field, fact.object);
      // Locations with a scene/action suffix are not treated as contradictory.
      if (observed === expected || (field === '位置' && observed.startsWith(expected) && /^(?:中|里|内|外)?(?:等待|寻找|修炼|休息|躲藏|停留|行动)/.test(observed.slice(expected.length)))) continue;
      conflicts.push({ subject: entity?.name ?? fact.subject, field, expected, observed, sourceChapter: fact.sourceChapter, sourceRevision: fact.sourceRevision, quote: fact.evidence.quote, answerExcerpt: clause });
    }
  }
  const numberValue = (text: string): number | undefined => {
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let total = 0, section = 0, digit = 0;
    for (const char of text) {
      if (char in digits) digit = digits[char]!;
      else if (char in units) {
        const unit = units[char]!;
        if (unit === 10000) { total += (section + digit || 1) * unit; section = 0; }
        else section += (digit || 1) * unit;
        digit = 0;
      } else return undefined;
    }
    return text ? total + section + digit : undefined;
  };
  for (const resource of state.resources) {
    const entity = state.entities.find(e => e.id === resolveEntityReference(state, resource.entity, false));
    const names = [...new Set([resource.entity, ...(entity ? [entity.name, ...entity.aliases] : [])])];
    for (const clause of clauses) {
      if (!names.some(name => clause.includes(name))) continue;
      if (subjectiveOnly(clause) || /曾经|此前|过去|最初|当时|之前|第\s*\d+\s*章/.test(clause)) continue;
      for (const name of names) {
        const amount = '[零一二两三四五六七八九十百千万\\d.]+';
        const match = new RegExp(`${esc(name)}(?:现在|目前|当前)?(?:的)?(?:还剩|剩余|拥有|持有)(${amount})(?:枚|块|个|颗|两)?${esc(resource.resource)}`).exec(clause)
          ?? new RegExp(`${esc(name)}(?:的)?${esc(resource.resource)}(?:余额|剩余|数量)(?:是|为|：|:|=)(${amount})`).exec(clause);
        if (!match) continue;
        const observed = numberValue(match[1]!);
        if (observed !== undefined && Math.abs(observed - resource.amount) > 1e-9 * Math.max(1, Math.abs(resource.amount))) conflicts.push({ subject: entity?.name ?? resource.entity, field: resource.resource, expected: String(resource.amount), observed: String(observed), sourceChapter: resource.sourceChapter, sourceRevision: resource.sourceRevision, quote: resource.evidence.quote, answerExcerpt: clause });
        break;
      }
    }
  }
  if (conflicts.length) warnings.push('检索回答与正式当前状态冲突；本章上下文以正式记忆为准，不采用该回答。');
  warnings.push('图谱由原文独立抽取；人物别名、认知与复杂语义仍须审阅，不能将作者视角知识直接赋予角色。');
  const status = conflicts.length ? 'conflicting' : evidenceStatus === 'verified' && !analysisTruncated ? 'supported' : 'needs-review';
  const value: Omit<RetrievalAssessment, 'assessmentHash'> = { policyVersion: 1, status, evidenceStatus, conflicts, warnings, accepted: status === 'supported', analysisTruncated, checkedCharacters: Math.min(60000, receipt.answer.length) };
  return { ...value, assessmentHash: hash(json({ receiptId: receipt.id, answerHash: receipt.answerHash, ...value })) };
}
