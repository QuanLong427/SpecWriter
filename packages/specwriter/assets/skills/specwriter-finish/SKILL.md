---
name: specwriter-finish
description: 对 SpecWriter 当前有效全书正文做完结检查，核对整体承诺、结局、未决问题和来源，按作者明确完结指令记录当前版本完成。用于检查或确认作品完结，不自动接纳草稿。
---

运行 resume/status，按 [生命周期核查](references/lifecycle.md) 的 finish 阶段检查当前有效全书正文。读取实际资料包、采用约定与适用指示，复用已有有效证据，有缺口才定向检索。空书、待接纳草稿或过期后文不能冒充全书已完成。

`finish prepare ID` 自动准备同 ID 生命周期任务，只检查全有效正文范围。先完成 memory check draft/save，核对 completed/fresh；再填写 finish show --draft 返回的 story-audits draft 并 finish save。机器 hookInventory 不改，summary/变化使用当前有效正式原文。已有明确完结指令才 `finish accept ID --reason TEXT`，完成状态用 finish status 查看。

实际核对整体承诺、主要人物与因果、结局实现、遗留问题及证据范围，再按 CLI 返回模板保存审阅。区分需要修订、证据不足与作者明确保留的开放问题；不为了通过强制闭合所有悬念、改造文风或套统一结局。准备资料包或引文校验通过都不表示完结审阅已经完成。

对仍开放的承诺逐项填写 hookDecisions；finish 仅在作者明确保留时 author-retained，authorReason 写真实作者原话。没有该选择时记录需解决的问题，不编造批准理由，也不把报告保存当伏笔自动 resolve。

needs-resolution 或未解决 blocking finding 保留 draft，处理后再 save；unknowns 与未解决 warning/suggestion 可保留，不把文学未知都变成强制结局。finish status 的 completed/invalidated 是当前证明状态；输入变化后旧 receipt 历史仍在，没有 reopen 命令，续写/修订仍需真实授权。

作者只要求检查时交付报告和可选修订，不能假造完结授权。作者已经明确要求当前版本完结时按实际指令记录接受理由，无需重复确认。完成记录只证明其绑定版本；正文、约定或相关输入变化后核对 freshness，旧记录仅保留历史用途，不复用为当前完成证明。

不自动修改正文、Specs、canon、伏笔状态或写作授权；需要修订时转 specwriter-revise 并遵守实际范围。交付可阅读报告，按作者要求另行导出正文和保存版本检查点，不宣称文学质量或百万字质量已验证。
