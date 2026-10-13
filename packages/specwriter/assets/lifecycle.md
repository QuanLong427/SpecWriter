# 全流程历史核查

计划、独立审阅、修订影响、阶段回顾和完结检查共用生命周期历史核查。Codex 完成有来源的判断，CLI 管理核查材料、范围、版本和完成记录；只准备资料包不表示核查已经完成。核查记录不新增小说事实，也不代替作者授权。

## 选择核查范围

| 阶段 | 核查目的 | 边界 |
| --- | --- | --- |
| plan | 写近期计划、章纲或改变方向前核对既有剧情、人物状态和未兑现承诺 | 只将范围内有效正式历史作为已发生依据，未来计划单列 |
| review | 独立审阅章节或剧情段，核对正文、约定、动机、认知及信息边界 | 区分当前目标正文与此前历史，不拿后文替目标角色解释知情路径 |
| impact | 修订旧章前分析受影响的人物、因果、资源、关系和伏笔，以及哪些后文要协调 | 后文是影响审计材料，不能混进目标章续写上下文 |
| recap | 对已接纳范围做计划落实、变化、承诺与遗留问题回顾 | 只回顾实际已写正文，计划没有实现不等于小说事实 |
| finish | 核对当前全书有效正文、整体承诺、结局与作者选择 | 草稿、过期后文和空书不能冒充完成；开放结局可由作者明确保留 |

普通研究与外部拆书仍按 [研究协议](research.md) 执行；讨论本书已发生历史、安排新剧情或改变旧章时，额外完成相应生命周期核查。新书历史为空时明确记录没有既有正文，不调用 GraphRAG 补造历史。

## 准备、实际核对与保存

在小说目录执行，ID 与范围使用实际任务值。`propose` 自动准备 `plan-<work>`，旧章工作包另准备 `impact-<work>`；查询失败会留下 pending request，按返回任务恢复，不丢弃任务重建工作包来绕门禁。旧工作包没有任务时保持兼容；Skills 在需要计划、独立审阅或修订核查时主动建立对应任务。

```powershell
node .specwriter/bin/specwriter.mjs memory check prepare review-opening-1 --stage review --work opening --chapter 1
node .specwriter/bin/specwriter.mjs memory check show review-opening-1 --draft
# 读取资料并编辑返回的 draftPath，完成实际判断后：
node .specwriter/bin/specwriter.mjs memory check save review-opening-1
node .specwriter/bin/specwriter.mjs memory check status review-opening-1
node .specwriter/bin/specwriter.mjs memory check list
```

prepare 支持 `--stage plan|review|impact|recap|finish`、可选 `--work ID --chapter N --from N --to N`，以及 `--question TEXT` 或 `--questions-file UTF8_JSON_ARRAY`、`--refresh` 与 review 新检索用的 `--retrieve`。范围必须符合阶段及有效正文；不要把未来计划章节当历史范围。问题文件使用 UTF-8 字符串数组，按本次需要选择问题，不把固定清单当所有作品的质量公式。

任务位于 `specwriter/memory/tasks/<id>/`：request.json 保存请求与失败后 pending 状态，draft.json 是可编辑核查报告，prepared/current 指针关联不可变 preparations/versions。prepare 返回 paths、draftPath、scope、history、sources、questions、query、inputFingerprint、preparedRevision 和 reused，读取实际返回值定位文件，不猜路径或复制旧任务机器字段。

先从本地 resume/status 和任务实际文件恢复范围，读取采用约定、适用作者指示及有效正文/正式记忆。按当前阶段准备核查材料，读取 CLI 返回的实际资料路径和模板；不要从聊天重新拼出已发生剧情。

先复用范围、版本与问题一致的已有材料和出处。必要状态、原文引文和来源已经足够时，不重复发起 GraphRAG 请求；存在证据缺口时才做有针对性的检索并回到原文核对。缺默认后端配置、网络、预算或来源时说明缺口，不静默改后端，不以检索建议替代正文事实。

实际调用边界：同 ID、scope、questions、预算且请求/准备输入仍 fresh 时，prepare 可直接复用 prepared；这只是材料复用，不是核查完成。绑定当前章的 review 默认验证并复用其 context 材料，query.engine=context-reuse 保留原 receipt，不额外查询；发现新疑点时用 --retrieve 或显式 question/questions-file 触发新检索。其他新阶段的非空历史将 questions 合并为一次 query，默认 WriterMemory.query 可复用 Provider 既有缓存；不同阶段或问题不保证缓存命中，不能承诺都不调用模型。准备后额外查询只补证据缺口，不重复查已经足够的出处；空历史完全不发 query。

检索 assessment.accepted=false 时，原始 GraphRAG 回答不写入可用核查结论，回到正式状态和原文处理缺口；不以回答带有出处就判定语义正确。

Codex 须实际回答本次核查问题，说明哪些结论由什么正文或已采用约定支持，哪些仍不确定；修正误读或提出需要作者决定的问题，再按实际模板保存完成记录。生成、展示或读取资料包都不等于完成核查。计划、独立审阅与修订不能跳过这一判断步骤直接宣布“历史已核对”。

编辑 draft 的 findings、reviewed 与 reviewNotes，保留全部机器字段。每个 finding 绑定模板给出的 questionId，填写 checked、verdict、conclusion、evidence 和 limitations。verdict 为 supported/uncertain/conflicting/not-applicable，不统一设为 supported。evidence 使用正式正文的 `{chapter,revision,bodyHash,quote,start?,end?}`：revision 是 SQLite 正整数正式版本 ID，quote 是该版本的连续逐字原文；重复引文精确定位。

非空历史的 supported/conflicting 需要至少一条正式原文引用；not-applicable 不能作为跳过历史的捷径，非空历史也需引用及 limitations 解释。history.atChapter=0 时可用空证据说明不适用。save 要求每题已 checked，conclusion、reviewNotes 有实际内容；uncertain/conflicting 可以保存为 recorded，但 completed=false，门禁仍阻止相应推进。只有必查题均 supported/not-applicable、证据有效且当前材料 fresh 才算完成。

review 任务另绑定当前 draftHash/contextHash。未接纳草稿没有正式 revision，不能填进 canonical evidence；对当前草稿的核对写 conclusion/reviewNotes，本章 review.json 仍保存其当前正文引用和逐项审阅。两份记录各有职责，不用生命周期历史记录代替实际章审阅。

工作包章审阅还绑定实际完成核查版本。memory check save 后重新运行 review-requirements，读取 memoryChecks 状态与 memoryCheckBindings，将清单中的 `{id,stage,revision}` 填入 review.json 的 memory_checks，再完成实际章审阅与 verify。这里只绑定本章有关的 plan/review/impact；核查结论更新产生新 revision 后重新审阅，不能用旧 review 冒用新完成记录，不能只替换绑定或哈希。旧无任务书保持兼容；作者不需手工填写这些字段。

review 有两种明确模式。有 work 时必须指定 chapter，并已有非空草稿与完整有效 context；提供 from/to 时两者必须等于目标章 N。缺 context 或过期时，默认与 --retrieve 都要求先章节 prepare/refresh，不能用新检索绕过。没有 work 时，用 chapter=N 或明确 from/to 选择已接纳有效正文，atChapter=to，draft/context binding 为 null；新任务执行一次历史查询，同任务可复用，不声称零模型。它只保存独立审阅，不创建修订工作包、不参与 work 门禁，也不进入 context；unknown/conflict 如实交付，未授权修订不等于必须改文或假报通过。

```powershell
node .specwriter/bin/specwriter.mjs memory check prepare opening-review --stage review --from 1 --to 3
node .specwriter/bin/specwriter.mjs memory check show opening-review --draft
# 实际读已接纳正文、核对问题并填写报告后：
node .specwriter/bin/specwriter.mjs memory check save opening-review
node .specwriter/bin/specwriter.mjs memory check show opening-review
```

plan/工作包 review 指定目标第 N 章时，检索前缀到 N−1；独立正式正文 review 检索到所审范围 to，包含目标正文；impact 使用返修前完整有效前缀；recap/finish 使用有效范围的 to/当前有效前缀。history.chapters 记录该前缀的正文版本身份，scope.from/to 是核查区间。按实际 scope/history 区分“检查哪段”与“读到哪章”，不从章节数字推断可偷看后文。

没有发现问题时也写清检查范围、主要依据与结论。引文/hash 校验只能证明版本与引用可定位，不能证明语义蕴含、人物动机或文学质量正确。个人风格偏好通常作为建议；真实连续性矛盾和违反作者明确硬约束才阻塞。

## 修订与后文影响

impact 检查可以读取后续正文以定位影响，但必须标为后文审计材料。目标章的 prepare/context 和写作记忆仍受原章节边界约束。影响分析不授予重写所有后文的权限，按作者已授权范围修订；接纳旧章后按实际 stale 范围顺序协调。

多章修订中，同一 work 范围内已授权正文变化可以保留原 impact 的历史影响用途；它仍引用返修前版本，不能伪装为目标章当前世界状态。范围外或其他输入变化按实际 freshness 重新核对，不由报告扩大授权。

修订、约定或指示变化后重新检查记录的范围与版本。旧核查记录保留历史用途，只有当前范围与材料仍一致时才能复用为当前依据；不能只替换哈希或沿用“已检查”的旧结论。

同 ID 的 stage/scope 不可改，--refresh 重检相同范围的输入变化。要扩大范围或切换阶段使用新 ID；特别是完结后追加新章，全书范围变大，重新 finish prepare 必须用新 audit ID。

## 阶段回顾与完结

```powershell
node .specwriter/bin/specwriter.mjs recap prepare opening-recap --from 1 --to 3
node .specwriter/bin/specwriter.mjs memory check show opening-recap --draft
# 先完成同ID的生命周期核查 draft，并 memory check save：
node .specwriter/bin/specwriter.mjs memory check save opening-recap
node .specwriter/bin/specwriter.mjs recap show opening-recap --draft
# 再填写阶段报告 draft，实际审阅后：
node .specwriter/bin/specwriter.mjs recap save opening-recap
node .specwriter/bin/specwriter.mjs recap show opening-recap
node .specwriter/bin/specwriter.mjs recap list
```

recap/finish prepare 自动准备同 ID 的生命周期任务并返回关联路径，不需要另跑一次 memory check prepare。报告 draft 位于 `specwriter/story-audits/<id>/draft.json`，seed prepared.json 和不可变 preparations/versions/current 保存版本关联。先完成并 save 同 ID 的生命周期任务，核对 completed/fresh 后才保存阶段报告。两类 prepare 均支持 question/questions-file/refresh；按实际返回模板填写，不手工改 hookInventory 或其他机器字段。

阶段报告可编辑 summary、characterChanges、mainlineChanges、hookDecisions、findings、unknowns、reviewed 与 reviewNotes。summary 与变化 claim 使用实际正式正文引文；至少一条位于本次 from..to，不能只引前史冒充本段变化。报告 evidence 为 `{chapter,revision,quote,start?,end?}`，与 memory check 的 bodyHash 字段职责不同，不相互复制模板。正文引用不来自未来计划。

recap 保存对选定已接纳范围的阶段报告，解释计划落实、人物/局势变化、伏笔与未决事项，并给下一阶段备选方向。它不自动改计划、约定或事实，不关闭工作包；archive 仍按完成范围单独执行。

hookInventory 由实际正式记忆生成，不能改清单以遗漏未决承诺。hookDecisions 包含 hookId、disposition、reason、authorReason 与 evidence。recap 可用 deferred 说明延后理由；需要解决的问题标 needs-resolution，不能写成已关闭。finish 对仍开放的承诺只可在作者明确保留时用 author-retained，并写真实作者原话 authorReason；不能自行替作者批准开放结局。正式伏笔状态不会因回顾或完结报告改变。

save 拒绝未实际 review、缺精确原文、机器字段改动、遗漏/重复 hookDecision、needs-resolution 及未解决的 blocking finding。问题未处理时保留 draft 并交付依据，不把结果改成已解决来保存。unknowns 可保留，未解决 warning/suggestion 不强制阻塞；风格探索和作者选择不能都变成硬性结局要求。finish 不接受 deferred，须解决正文中的承诺或有真实作者保留选择。

```powershell
node .specwriter/bin/specwriter.mjs finish prepare book-finish
node .specwriter/bin/specwriter.mjs memory check show book-finish --draft
# 读原文、完成生命周期核查后：
node .specwriter/bin/specwriter.mjs memory check save book-finish
node .specwriter/bin/specwriter.mjs finish show book-finish --draft
# 填写并实际审阅全书报告后：
node .specwriter/bin/specwriter.mjs finish save book-finish
node .specwriter/bin/specwriter.mjs finish show book-finish
node .specwriter/bin/specwriter.mjs finish list
node .specwriter/bin/specwriter.mjs finish status
# 仅在已有真实作者完结指令时：
node .specwriter/bin/specwriter.mjs finish accept book-finish --reason "实际作者完结指令"
```

finish 对当前全书有效正文完成审阅，区分已兑现、需要修订、作者明确保留的开放问题和证据不足。不要为“完结”强制所有伏笔都关闭、统一结局风格或机械计算爽点；开放结局需要与作者选择和已采用承诺一致。

完结检查与作者确认完结是不同动作。作者已经明确要求当前版本完结时按实际指令记录，不重复询问；只要求检查时交付审阅，不假造接受理由或自动完结。完结记录绑定当前材料版本，正文、约定或相关输入变化后旧完成记录不能作为当前完结证明；历史记录保留。

finish status 返回 status=unfinished/completed/invalidated、completed、completion、reasons、reports、current 与 history；accept 返回 receiptPath 和 valid。完成证明保存在 `specwriter/completion/receipts/<receiptId>.json`，current.json 指向当前证明，绑定报告 revision、全书正文 chapter/revision/bodyHash、范围、Specs 文件、采用约定、instruction、feedback 和生命周期准备/审阅。新章、返修或相关输入变化使其动态失效，旧证明仍保留。没有独立 reopen 命令，继续写或修订仍需要作者真实授权，完结证明不授予该权限。

已发布报告读取不依赖可变 draft；draft 缺失或损坏通过 draftError 单列，历史报告仍可读，但当前完结证明失效，不能忽略未审/损坏草案继续宣称完成。

本流程不执行无人值守写作，也不能证明真实长篇或百万字质量。外部研究、计划、核查报告和后文审计材料不会变成本书事实或默认 GraphRAG 的目标章语料。
