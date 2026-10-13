---
name: specwriter-recap
description: 对 SpecWriter 已接纳章节范围做阶段或卷回顾，核对计划落实、人物与局势变化、伏笔和遗留问题，保存带正文依据与版本的报告。用于剧情段复盘，不自动归档或完结。
---

运行 resume/status，按作者指定的有效正式章节范围执行 [生命周期核查](references/lifecycle.md) 的 recap 阶段。读取 CLI 返回的实际资料包与模板，复用当前有效证据；存在来源缺口时才检索原文。空历史不调用 GraphRAG，也不把未来计划写成既成事实。

`recap prepare ID --from N --to N` 自动准备同 ID 的 memory check，不重复准备。先读并完成 memory check 返回 draft、save，核对 completed/fresh；再读 recap show --draft 返回的 story-audits draft，填写并 recap save。完整命令与字段按生命周期协议及实际模板；summary/变化至少引用本段正式原文，机器 hookInventory 不改。

实际完成核查，再填写阶段报告：哪些计划已实现或偏离、人物/局势发生了什么变化、承诺怎样推进、哪些问题要留到后续。每项判断核对正文与采用约定，保留不确定事项；资料准备不等于回顾完成，引文可定位不等于判断正确。

对开放承诺逐项填写 hookDecisions。recap 可以 deferred 并说明理由，needs-resolution 保留 draft、处理后再 save，不冒充已兑现；需要作者保留时记录真实依据，不改正式伏笔状态或为了归档消除问题。unknowns 与未解决 warning/suggestion 可以保留，不能把所有风格选择强行当阻塞。

按当前模板保存版本绑定的回顾，交付主要发现、依据与下一段可选方向。保持作者的文风与开放空间，不自动改 Specs、instruction、canon 或工作包授权。归档用 archive 专项流程，作品完结用 specwriter-finish；正文变更后先核对报告是否仍有效。
