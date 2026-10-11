// Fixture records for model-free examples. Real writers must make and document each check themselves.
export const demoReview = (template, metadata) => ({ ...template, ...Object.fromEntries(['chapter', 'contextHash', 'draftHash', 'intentHash'].map(key => [key, metadata[key]])), reviewed: true,
  checks: Object.fromEntries(['evidence', 'coverage', 'continuity'].map(key => [key, { checked: true, notes: ['内置演示数据已核对；不是模型质量评分。'] }])) });
