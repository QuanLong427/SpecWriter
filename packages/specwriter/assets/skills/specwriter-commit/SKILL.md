---
name: specwriter-commit
description: 接纳 SpecWriter 小说正文版本，通过校验将正式正文与有证据的长期记忆一起提交，并报告后续影响。
---

阅读 [项目协议](references/protocol.md) 的提取、审阅与提交规则。用户当前要求接纳，或已有明确自动接纳授权时继续，无需重复确认。

核对目标 work/chapter，确保版本 2 提取和审阅针对当前正文、章纲及上下文，三项审阅检查有实际依据，先运行 verify 再 commit。失败时修复实际原因，不只替换哈希或把阻塞项改成已解决。projectionNeedsSync=true 表示数据库已提交，运行 sync 修复文件；不要重复提交。报告接纳版本、记忆同步范围和需要核对的后续章节。

新上下文还要求 critical_checks 与当前提取逐项绑定；未采用的检索回答需要 retrieval_check 说明核对依据。按 [版本与备份](references/versioning.md) 使用每本小说独立 Git 检查点。启用后接纳会自动保存；versionNeedsSave=true 表示正文已接纳但检查点失败，修复原因后 version save，不能重复接纳。用户要求恢复时保留原书，校验后恢复到新目录。
