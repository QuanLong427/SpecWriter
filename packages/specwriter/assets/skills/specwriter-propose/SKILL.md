---
name: specwriter-propose
description: 为 SpecWriter 小说建立创作约定、滚动卷计划或有章节范围的写作与修订工作包。用于把已选定的创意转为可执行计划。
---

阅读 [项目协议](references/protocol.md) 和 [创作流程](references/workflow.md)。运行 resume；首次创作与作者共同完善四份 Spec，按既有选择 contract adopt 固定已采用版本，区分草案和待决问题。

按已有作者指令 work authorize，记录范围、draft/auto 与理由。开始章节前 intent seed，完成 JSON 并 intent save，不把空模板当可执行章纲。

保留全书方向，只细化当前卷或剧情段。通过 propose CLI 创建具有明确章节范围的工作包，完善 proposal 的作者意图、读者体验、必须保留和避免、场景方向。设定变更写清受影响约定和历史正文范围；必要时创建 spec-changes.md。未来计划不得变成已发生事实。让作者能看到将写什么和哪些空间可以自由发挥。

将明确正向/禁止要求保存有范围的 instruction，待决探索不升级为指示，授权 reason 不代替创作要求。追溯约定/书籍指示时核对历史影响，按授权顺序协调，不自行扩大修订范围。

采用研究或题材方法时按 [研究协议](references/research.md) 核对本书已保存报告、来源范围和作者选择，区分创作目标、可调整手法与硬约束；保存报告/use profile 不代表已采用全部建议。已选做法先整理 Specs 或有范围的 instruction，再按实际授权 adopt。需要本章参考时在 intent.references 写 id、purpose 和可选 revision，最多8份，不塞入 planPaths；报告与外部作品不进入正式记忆或默认 GraphRAG。

按 [生命周期核查](references/lifecycle.md) 实际完成 plan 核查再交付可执行计划。propose CLI 自动准备 `plan-<work>`，旧章修订另准备 `impact-<work>`；按返回任务恢复，不重复准备制造查询。读资料与原文后填写 findings/reviewNotes 并 memory check save，核对 completed/fresh；prepared 不是完成，uncertain/conflicting 不冒充已核对。空历史不调用 GraphRAG。后文 impact 独立保存，不混入目标章上下文，也不扩大修订授权。
