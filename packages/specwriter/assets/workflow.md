# 从作者意图到连续小说

新书采用 structured 工作流。没有 workflow 配置的旧书保留原流程；作者决定升级时采用一次 contract 即启用新流程，历史正文不重写。在书籍目录执行 `node .specwriter/bin/specwriter.mjs <command> --json`。用户用自然语言与 `$specwriter`，Codex 操作内部命令。

## 初次创作

1. `resume` 恢复任务。首次创作与作者确定题材、主线、人物、世界硬约束和文风，先完成可审阅方案。
2. 按作者选择填写四份 `specwriter/specs/{premise,world,characters,style}.md`，运行 `contract adopt --reason "真实作者指令或采用理由"`。默认从下一连续有效章节生效；修改旧章约定用 --from N 并核对历史影响。采用约定本身不修改正文，CLI 会 sync。
3. `propose opening --title "开篇" --from 1 --to 3` 并填写 proposal；保留全书方向，展开近期场景。
4. `work authorize opening --from 1 --to 3 --acceptance draft --reason "作者要求先看开篇草稿"`。作者已明确授权自动接纳时使用 auto。不能从“继续写”推断自动接纳或扩大范围，已有授权不重复问。
5. 按章节循环执行。可建议 version init 启用每本书的独立 Git 检查点，见 versioning.md。

contract show 显示已采用版本和修改过的草稿。改 Spec 不会自动替换 adopted contract，作者正式改变约定时重新 adopt。采用变化使未完成上下文失效；正文历史和 GraphRAG 原文前缀不改变。未来计划与创作约定都不能当作已发生事实。

## 每章循环

1. `resume --work opening` 查看章节、授权、暂停和下一步，没有模型调用，实际文件决定状态。
2. `intent seed 1 --work opening` 获取已采用约定、上章结尾、近期摘要和候选人物。填写 intent.json 的目标、场景、人物稳定 ID、新人物、POV、故事时间、必选状态/余额/事件/伏笔、认知检查、暂不揭露内容、预期变化、目标字数及选中的计划路径。schema 见 chapter-intent.schema.json。初始空目标和场景不能保存；需要久远人物或因果时查询正式记忆与原文。
3. `intent save 1 --work opening` 校验必选依赖，生成 intent.md。修改 JSON 后重跑 save，不手改生成的 Markdown。新人物先在 newEntities 声明，列入计划不等于正式登场。
4. `prepare 1 --work opening` 后读取完整 context.json。后续章节默认 Microsoft GraphRAG 查询已接纳前缀，问题来自本章目标、人物和依赖。参与人物/POV 的已登记关键世界状态、余额、显式依赖和上章结尾受保护，预算不足会拒绝。其他记忆按预算选取。缺少必选记录时核对历史或明确调整章纲，不编造依赖。
5. 写 draft，从当前正文填写 memory-delta。计划变化实际发生后才提取；偏离计划先改 intent、save、prepare --refresh，保留草稿后重新提取审阅。expectedChanges 不自动入库。
6. `hash`、`review-requirements` 后实际审阅。critical_checks 核对正式变化；intent_checks 核对目标、认知及暂不揭露事项。goal/knowledge 要精确正文引用；withhold 可以空引用，但需解释核对了哪些场景、为何没有提前揭露。确实符合才 satisfied，uncertain/violated 应修正文或报告阻塞。按需读历史核对获知路径；没有登记认知不等于一定未知或已知。
7. verify 通过后 draft 模式交付阅读和批注；作者接纳后把实际授权范围改为 auto，再 commit。auto 模式逐章 commit，检查后文过期、投影、备份状态，再 resume。只改 draft→auto 不需要刷新已完成的审阅；正文/章纲/上下文变化必须重新提取审阅。
8. 到授权边界停止新章，提供 read、read --draft --work opening 或 export。全部接纳才能 archive；作者确定新范围后另建工作包。

## 暂停和恢复

收到暂停请求运行 `work pause opening --reason "作者要求先审阅"`。read/review/verify 仍可用，prepare/commit 拒绝。作者要求恢复后 `work resume opening --reason "作者要求继续原范围"`，重新加载 resume 指向的文件。旧章修订产生 stale 后文时逐章核对，不把未来章当当前事实。Git 恢复到新目录会保留约定和授权；暂停状态也会保留。

授权与约定在外部 GraphRAG 调用前和接纳前检查；调用期间变化不会保存旧上下文。memory budget 继续限制用量，触发时保留成果，不自清限制。CLI 不独立生成或常驻写作，连续创作由 Codex 执行。

引用和哈希使审阅可追踪，不能证明文学质量或百万字不跑偏。语义与文学判断由 Codex 和作者负责。本阶段未提供自动卷回顾、整书导入、完结检查或无人值守服务。
