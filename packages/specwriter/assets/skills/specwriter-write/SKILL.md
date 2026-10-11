---
name: specwriter-write
description: 在 SpecWriter 小说项目中继续写章节或执行已确定的章节计划，取回长期记忆，生成正文、候选事实及审阅结果。
---

按 [项目协议](references/protocol.md) 恢复进度，选定当前工作包和下一章，运行 prepare。读取 context 中的约定、计划、带证据的记忆和必要历史原文，完善 intent 后写草稿。

按 [记忆协议](references/memory.md) 记录稳定实体、事件因果、资源余额、伏笔依赖及人物认知；只提取有正文依据的内容。prepare 默认索引边界内正文并取回 Microsoft GraphRAG 结果；核对其原文来源与正式状态，检索建议不自动成为事实。涉及久远人物或伏笔时追加 memory query；角色认知核对可显式 --backend local --holder。缺少默认后端配置时明确报告并按协议配置，不静默回退。

用场景实现本章目标，保留表达自由；遵守角色认知与读者揭露边界。正文完成后获取 hash，依据当前草稿填写 [事实 schema](references/chapter-delta.schema.json) 与 [审阅 schema](references/review.schema.json)，运行 verify。授权范围内接纳，否则展示可审阅草稿和关键问题。批量写作按章检查与提交，不能把未写出的计划提前入库。
