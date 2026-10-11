import { criticalClaims } from '../dist/index.js';
// Fixture records for model-free examples. Real writers must make and document each check themselves.
export const demoReview = (template, metadata, delta) => ({ ...template, ...Object.fromEntries(['chapter', 'contextHash', 'draftHash', 'intentHash'].map(key => [key, metadata[key]])), reviewed: true,
  critical_checks: delta ? criticalClaims(delta).map(item => ({ claimHash: item.claimHash, verdict: 'supported', evidenceQuote: item.evidenceQuote, explanation: `内置人工样例已核对：${item.claim}；不是模型语义评分。` })) : [],
  ...(template.retrieval_check ? { retrieval_check: { ...template.retrieval_check, notes: '样例仅使用正式记忆和原文，不采用未获支持的检索回答。' } } : {}),
  checks: Object.fromEntries(['evidence', 'coverage', 'continuity'].map(key => [key, { checked: true, notes: ['内置演示数据已核对；不是模型质量评分。'] }])) });
