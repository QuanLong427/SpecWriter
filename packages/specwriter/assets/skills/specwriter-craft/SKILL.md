---
name: specwriter-craft
description: 为 SpecWriter 小说选择和定制原创题材写法，提供玄幻升级、都市职业、悬疑推理、言情关系和历史权谋的方法参考。用于写法讨论、场景卡点或审阅，不声称热榜实证。
---

运行 status，读取相关已采用约定、作者目标和当前场景。按 [研究协议](references/research.md) 用 craft list/show 选择相关 profile；只读本次需要的方法，可混合或拒绝，不默认整本书必须套同一套路。

profiles 是项目原创经验，覆盖读者承诺、冲突循环、场景、对白、长线推进、审阅问题、陷阱和作者定制，不能包装成当前市场数据或经验证的成功公式。适配时按需读 [方法定制](references/adaptation.md)。不要规定固定爽点数量、统一甜虐比例或所有题材相同的节奏。

作者需要保存参考时用 `craft use PROFILE --as REPORT`，读取返回的本书报告与来源。结合本书提出具体可选改法，说明它解决的问题、代价及不适合的情形。作者选定后再整理 Specs 或有范围的 instruction 并按实际授权采用；use 不自动采用约定，也不建立硬性审阅门槛。

写作/审阅使用已选方法时，显式加入 intent.references 并写 purpose，资料变化后 save/refresh。把方法当创作参考；只有违反作者明确采用的硬约束或真实连续性矛盾才阻塞，不将风格建议伪装为不合格。外部作品机制分析转 specwriter-analyze，近期市场问题转 specwriter-research。
