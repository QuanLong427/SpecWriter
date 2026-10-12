# 从作者意图到连续小说

新书采用 structured 工作流。没有 workflow 配置的旧书保留原流程；作者决定升级时采用一次 contract 即启用新流程，历史正文不重写。在书籍目录执行 `node .specwriter/bin/specwriter.mjs <command> --json`。用户用自然语言与 `$specwriter`，Codex 操作内部命令。

## 可选的创作研究

作者只用 `$specwriter` 即可请求市场调研、拆书或题材方法。总入口分别路由 research、analyze、craft；普通构思无需先做调研。市场当前信息使用 Codex 实际可用的联网搜索/浏览工具，CLI radar 只抓番茄/起点公开榜单，不需要额外搜索 Key，也不是 Qwen 搜索能力。无联网工具或无法访问时明确来源不足，可用作者文件/摘录，不伪造最新数据。

按 [研究协议](research.md) 保存材料、已读范围、观察、推断、备选方向与未知项。拆书提炼机制，不搬名字、表达或标志性情节；内置五类 craft profiles 为原创经验，可定制而非热榜实证。研究不会自动改 Specs/canon，也不授予写作或接纳权限。

需要时按“调研 → 拆书/题材方法 → 作者选定 → Specs 采用 → 章纲 references → 写章/审阅”推进。作者已有选择直接落实，不重复确认；保存报告或 craft use 不代表整份方法已采用。将选择整理为目标、可调整手法和明确硬约束，再进入下面初次创作流程。

## 初次创作

1. `resume` 恢复任务。首次创作与作者确定题材、主线、人物、世界硬约束和文风，先完成可审阅方案。
2. 按作者选择填写四份 `specwriter/specs/{premise,world,characters,style}.md`，运行 `contract adopt --reason "真实作者指令或采用理由"`。默认从下一连续有效章节生效；改变旧章约定用 --from N，受影响正式范围需顺序重审。改 Spec 草稿不会替换采用版本。
3. `propose opening --title "开篇" --from 1 --to 3` 并填写 proposal 的作者意图、必须保留和避免、近期场景方向。未来计划不能作为已发生事实。
4. `work authorize opening --from 1 --to 3 --acceptance draft --reason "作者要求先看草稿"`。已有明确逐章接纳授权才用 auto；不重复询问已给授权，不扩大范围。
5. 保存具体作者指示，按章执行下方循环。可用 version init 启用每本书独立 Git 检查点。

## 保存作者指示

持续或跨章要求不能只留在聊天或 work authorize.reason 中。按实际指令记录，例如：

```powershell
node .specwriter/bin/specwriter.mjs instruction add keep-ferry --text "第一章保留渡口冲突" --kind require --from 1 --to 1 --work opening
node .specwriter/bin/specwriter.mjs instruction add no-early-reveal --text "开篇三章不要揭露灯柄缺口用途" --kind avoid --from 1 --to 3 --work opening
node .specwriter/bin/specwriter.mjs instruction list --chapter 1 --work opening
node .specwriter/bin/specwriter.mjs instruction retire no-early-reveal --reason "作者允许后续揭露用途"
```

from/to 控制章节；本书指示省略 to 可持续适用。--work 限定工作包，此时必须给明确 --from/--to 且范围在 active 工作包内；省略 --work 则按本书章节范围适用。require 是正向要求，审阅需当前正文引用；avoid 是禁止事项，需实际核对说明。指示不是事实，也不授予写作范围或自动接纳权限。

改变要求时记录停用理由并新增明确范围的新指示，不保留互相冲突的有效要求。新增追溯历史的书籍指示会使受影响正式范围需重审，按实际授权协调。retire 停止后续准备使用该指示，不改写已接纳版本的指示快照。局部批注影响未来方向时另记 instruction，不能从一条章内意见推定全书要求。

## 每章循环

1. `resume --work opening` 查看章节、授权、暂停与反馈门禁，无模型调用；检查适用 instruction 和未处理批注。
2. `intent seed 1 --work opening` 获取采用约定、上章结尾、摘要和候选人物。填写 intent.json 的目标、场景、稳定 ID、新人物、POV、故事时间、必选状态/余额/事件/伏笔、认知检查、暂不揭露事项、预期变化、字数和计划路径。需要研究参考时另填 references，不混进 planPaths。久远依赖先查正式记忆与原文。
3. `intent save 1 --work opening` 校验依赖并生成 intent.md。改 JSON 后重跑 save，不手改生成 Markdown。声明新人物不代表正式登场。
4. `prepare 1 --work opening` 后实际读取完整 context.json。第 N 章只索引与检索 N−1 之前的连续有效正式正文；采用 Specs、proposal、章纲、适用指示、采纳反馈、显式选中研究及其来源、必要状态与上章结尾进入资料包。关键输入预算装不下就拒绝，不删依赖或来源掩盖矛盾。
5. Codex 写 draft，再从当前正文提取 memory-delta。改章纲或采用新反馈/指示后 refresh 并重新提取审阅，不沿用旧哈希。计划实际发生后才提取，expectedChanges 不自动入库。
6. `hash`、`review-requirements` 后实际审阅。critical_checks 核对变化；intent_checks 按返回清单核对目标、认知、暂不揭露事项、作者指示和采纳反馈。正向要求需正文引用，禁止项需实际核对说明；uncertain/violated 要修正文或报告阻塞，不统一勾选通过。
7. verify 后 draft 模式交付；作者接纳后记录实际 auto 授权再 commit。auto 模式逐章 commit 后 resume。接纳把采纳批注绑定正式 revision；只完成草稿仍待正式落实。仅切换 draft→auto 不需重做已完成审阅。
8. 第一章未接纳不能准备第二章。到授权边界停止；范围全部有效才能 archive。旧工作包历史草稿不应挡住已完成进度，存在不同草稿时按作者意图选择。

context.json 是供 Codex 按 Skill 读取的资料包，CLI 不清空或强制注入真实模型上下文。版本校验能阻止旧资料包接纳，不能证明模型读完材料或没有受旧聊天影响。先恢复本地任务、读取当前资料，不从聊天重建已发生剧情。

intent.references 最多8项，每项为 `{id,purpose,revision?}`，只选择不同的本书已 save 报告；不指定 revision 取最新已保存版本，指定64位哈希固定版本。purpose 说明本章用途。资料条目含报告、必要引文/引用位置与捕获来源元信息/路径，纳入 context hash 并受预算保护；完整原文按来源路径读取核对。实际选中版本或绑定来源变化后 intent save/prepare --refresh、重新提取审阅。固定旧版本时新报告不自动替换它，未选研究不作为本章隐式输入。研究始终是参考，不成为本书事实、角色已知或默认 GraphRAG 语料。

## 阅读反馈与修订

作者把“复制给 Codex”的请求粘贴到本书对话，或要求读取批注。请求带书名、bookId 和小说路径，先核对身份。页面不主动发消息、唤醒 Codex 或中断正在生成的内容。

Codex 核对来源版本与引用，用 feedback decide 记录 adopt/decline/clarify 及理由。adopt 须覆盖目标章的 active 工作包；旧意见先在当前来源正文重新定位，原旧哈希/引用保留。采纳快照进入目标章 context 和审阅，正式接纳后才记录 applied revision。落实记录失败时用 feedback reconcile 补记已接纳结果，不重复接纳。命令见 [阅读协议](reader.md)。

作者勾选“先处理再继续”的未处理意见阻止后续 prepare/commit；明确采纳的目标工作包和同一章允许修订，其余后续推进仍暂停。门禁在下一次 CLI 检查生效，不是模型实时中断。clarify 保持待处理，decline 需作者取舍依据，不能为继续写作随意拒绝；人工 resolve 不绕过门禁。

## 暂停、旧章协调与交付

暂停用 `work pause opening --reason "作者要求先审阅"`；阅读和审阅仍可用。作者要求恢复才 `work resume opening --reason "作者要求继续"`，重新读 resume 指向的文件。解除暂停不代表反馈已处理。

旧章修订或追溯采用约定使后文需重审时，从第一个 stale 章顺序核对、提取、审阅和接纳，遵守授权。未来/stale 正文不能成为当前章事实。后文仍可阅读，但导出只含连续有效前缀；修复后再交付。

外部 GraphRAG 调用与接纳边界重新校验输入、授权、反馈；变化后刷新。用量限制触发时保留成果，不自行放开限制。引用、哈希和审阅使任务可追踪，不证明文学质量或百万字不跑偏。自动卷回顾、整书导入、完结检查、无人值守服务仍未实现。
