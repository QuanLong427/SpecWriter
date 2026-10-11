---
name: specwriter-write
description: 在 SpecWriter 小说项目中继续写章节或执行已确定的章节计划，取回长期记忆，生成正文、候选事实及审阅结果。
---

按 [项目协议](references/protocol.md) 恢复进度，选定当前工作包和下一章，运行 prepare。读取 context 中的约定、计划、带证据的记忆和必要历史原文，完善 intent 后运行 prepare --refresh，再写草稿。章纲是受校验的创作输入，修改后不能沿用旧上下文。

按 [记忆协议](references/memory.md) 记录稳定实体、事件因果、资源余额、伏笔依赖及人物认知；只提取有正文依据的内容。prepare 默认索引边界内正文并取回 Microsoft GraphRAG 结果；核对其原文来源与正式状态，检索建议不自动成为事实。涉及久远人物或伏笔时追加 memory query；角色认知核对可显式 --backend local --holder。缺少默认后端配置时明确报告并按协议配置，不静默回退。

用场景实现本章目标，保留表达自由；遵守角色认知与读者揭露边界。正文完成后获取 hash，依据当前草稿填写版本 2 的 [事实 schema](references/chapter-delta.schema.json) 与 [审阅 schema](references/review.schema.json)，绑定 intentHash。证据标明 established/reported/inferred/imagined；重复引用填写精确字符偏移。审阅记录证据支持、提取遗漏和连续性三项实际检查依据，再运行 verify。不能复制示例检查说明来冒充审阅。授权范围内接纳，否则展示可审阅草稿和关键问题。批量写作按章检查与提交，不能把未写出的计划提前入库。

位置、生死、境界、真实身份只能有一个当前世界状态；变更用 state_changes 并匹配 old_value。提取后运行 review-requirements，逐项填 critical_checks，按 specwriter-review 的审阅规则执行。context.retrieval.assessment 会说明来源缺失和已识别的当前状态/余额冲突；accepted=false 的回答不会进入续写素材，须用正式记忆和原文核对并填写 retrieval_check。人物相信、梦见或听说的结论不能直接记成世界真相。
