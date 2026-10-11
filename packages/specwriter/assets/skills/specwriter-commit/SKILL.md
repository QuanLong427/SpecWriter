---
name: specwriter-commit
description: 接纳 SpecWriter 小说正文版本，通过校验将正式正文与有证据的长期记忆一起提交，并报告后续影响。
---

阅读 [项目协议](references/protocol.md) 的提取、审阅与提交规则。用户当前要求接纳，或已有明确自动接纳授权时继续，无需重复确认。

核对目标 work/chapter，确保提取和审阅针对当前正文及上下文，先运行 verify 再 commit。失败时修复实际原因，不只替换哈希或把阻塞项改成已解决。projectionNeedsSync=true 表示数据库已提交，运行 sync 修复文件；不要重复提交。报告接纳版本、记忆同步范围和需要核对的后续章节。
