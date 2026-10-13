---
name: specwriter-review
description: 审阅 SpecWriter 章节或剧情段的连续性、创作约定与阅读体验，提供有正文依据的问题和修改建议。
---

阅读 [项目协议](references/protocol.md)，恢复进度并定位作者指定版本。检查事实矛盾、人物动机与认知、信息揭露、未兑现承诺和明确的创作约定；按需读取相关正式原文。

作者已提供阅读批注时，按 [阅读协议](references/reader.md) 读取对应 feedback，检查正文哈希和引用；区分当前与旧版本意见，把反馈作为审阅线索。需要作者预览时提供 read --draft --work ID 命令，批注不会自动接纳正文。

记录问题与依据，区分阻塞矛盾和表达建议；不要把主观偏好当作硬性不合格。对可提交草稿获取当前 hash，填写版本 2 的 [审阅 schema](references/review.schema.json)，绑定 intentHash，设置 reviewed=true。checks.evidence 核对每条引用是否支持结论、传闻是否误升为真相；checks.coverage 核对遗漏的关键动作、状态、资源、伏笔；checks.continuity 核对历史、章纲、视角和信息边界。三项均记录实际依据和发现的问题，完成后才置 checked=true；没有问题也需说明核对了哪些内容。较长剧情段可另写工作包 review.md；本命令不自动重写或接纳正文。

提取完成后运行 `review-requirements N --work ID --json`。逐项审阅 criticalClaims，填写 critical_checks 的 claimHash、精确 evidenceQuote、verdict 和实际 explanation；只有原文确立结论才选 supported。不支持或不确定时修正候选提取、改为角色认知或报告阻塞问题，不为通过校验统一勾选。提取变化后重新获取清单。检索 assessment.accepted=false 时读取正式记忆及原文，在 retrieval_check 填当前 assessmentHash、use-formal-memory 和核对说明；不能采用被排除的回答。引用存在和规则检查通过都不能证明复杂语义成立。

结构化上下文额外按 review-requirements.intentChecks 填 intent_checks（id、verdict、evidenceQuotes、explanation）。目标和认知需当前正文引用；暂不揭露事项可空引用，但应说明检查范围及没有提前揭露的依据。实际符合才 satisfied；角色知识须追溯获知路径，未登记不等于未知。

按 review-requirements 全部 intentChecks 核对指示/采纳反馈：require 需当前正文引用，avoid 需核对范围，资料齐全不代替语义判断。反馈取舍保存理由，草稿审阅不表示正式落实；人工 resolve 不证明正文修改。

已选研究/题材方法按 [研究协议](references/research.md) 核对用途、来源范围与采用状态。references 只是参考，不能从一个 profile 自动推导硬约束；有依据的风格改法通常作 suggestion/warning。按作者选定的读者承诺与文风审阅，不统一要求固定爽点、甜虐比例或节奏。报告引文/hash通过不证明市场推断或机制判断成立，外部分析不代替本书正文证据。

按 [生命周期核查](references/lifecycle.md) 选择实际目标。当前工作包草稿创建 `review-<work>-<chapter>` 的 stage=review 任务，绑定 work/chapter、非空草稿与有效 context，默认复用 context；新疑点才 --retrieve 或显式问题。独立审阅已接纳章节用无 work 的 `memory check prepare ID --stage review --chapter N` 或明确 from/to，查询到 to，实际读该范围原文与出处后保存判断；不创建修订工作包，不改正文，不参与写作门禁或 context。prepared 不是完成，uncertain/conflicting 保留真实结论；独立审阅允许报告这些问题，不因未授权修订而假报通过。

当前草稿核查 completed/fresh 后再 verify；历史 evidence 只填正式章节的 chapter/revision/bodyHash/quote，未接纳草稿的核对写 conclusion/reviewNotes，另在本章 review.json 留当前引用，不假造正式 revision。已有核查仍须检查 fresh，正文变更后旧报告只是历史。空历史不调用 GraphRAG。

工作包核查 save 完成后重新运行 review-requirements，核对 memoryChecks 并将 memoryCheckBindings 的实际 `{id,stage,revision}` 填入 review.memory_checks，再实际审阅并 verify。plan/review/impact 结论版本更新后须重审，不能只替换绑定让旧 review 借新包通过；旧无任务书仍兼容。独立正式审阅只保存生命周期报告，不假造工作包章审阅。
