# SpecWriter

面向 Codex 的本地长篇小说写作工作流。SpecWriter 管理创作约定和滚动计划；WriterMemory 维护从正式正文提取的有来源、可追溯、带章节边界的长期记忆。

要求 Node.js 24+。Node 24 的 `node:sqlite` 会提示 experimental；当前实现与测试使用 Node 24.14。WriterMemory 默认使用 Microsoft GraphRAG，需要 Python >=3.11,<3.14、GraphRAG 3.3.x 和模型配置。显式 local 模式的检索不调用模型。

本轮补齐重要边界：关键当前状态唯一性、声明与证据逐项审阅、检索引用状态与正式记忆冲突核对，以及每本小说独立的 Git 检查点和迁移恢复。自动核对覆盖常见明确句式，复杂语义仍由 Codex 审阅。

## 作者从哪里开始

安装后，在 Codex 中打开 **小说目录**，使用 `$specwriter` 总入口。作者提供想法、授权与阅读意见，Codex 操作章纲、记忆和内部命令。下面是一套可直接发给 Codex 的使用顺序。

| 阶段 | 发给 Codex 的示例 | 得到什么 |
| --- | --- | --- |
| 构思 | `$specwriter 构思一部长篇河镇悬疑小说，先给我四份设定和开篇三章计划，暂不写正文。` | 可审阅的创作约定和近期计划 |
| 第一章草稿 | `$specwriter 采用当前设定，把开篇三章作为工作包，本次只授权第一章草稿。完成章纲、写作、提取和审阅后给我看，先不接纳。` | 已采用约定、draft 授权、章纲和可阅读草稿 |
| 草稿修订 | `$specwriter 按阅读器中第一章的批注修订，重新提取审阅，先给我看。` | 修改后的草稿和版本绑定的审阅 |
| 接纳与连续写作 | `$specwriter 接纳修改后的第一章，继续写第2至第3章，授权每章审阅和verify通过后自动接纳，到第3章停止。` | 逐章正式正文和更新后的长期记忆 |
| 暂停 | `$specwriter 暂停当前工作包，我先审阅。` | 保存暂停，阅读和审阅仍可用 |
| 换会话 | `$specwriter 从当前目录恢复进度，先说明正式章节、待审稿与过期后文，不继续写。` | 从本地记录恢复任务，作者明确要求恢复后再推进 |
| 阶段交付 | `$specwriter 回顾并归档开篇工作包，导出当前有效正文并保存Git检查点。先给我下一段计划，不写新章。` | 工作包回顾、TXT/Markdown/HTML、备份与后续计划 |

**第一章未接纳时不能准备第二章。** 连续创作按章进行：章纲与取记忆 → 草稿 → 提取审阅 → verify → 按授权 commit → 下一章。draft 只允许写和审阅，auto 才能接纳；不能先生成全部三章草稿再共用正式记忆。已有明确授权无需每章重复确认，到范围边界停止。

阅读器负责阅读与批注，正文由 Codex 修订。小说目录中运行 `node .specwriter/bin/specwriter.mjs read` 看正式正文；草稿用 `read --draft --work ID`，ID 取实际工作包。命令持续运行，Ctrl+C 停止；后续命令使用其他终端。批注后在对话中要求 Codex 修订，批注本身不自动改文。

旧章重新接纳会让后文记忆需要重审，按授权逐章协调后再导出；过期批注要重新定位。`exports/novel.{txt,md,html}` 只包含连续有效正式章节。启用 version init 后接纳自动备份；单独改设定、批注或归档后 version save。每本书的数据隔离，Python/Ollama/BGE-M3 可以共用。

完整内部步骤见 [创作流程](assets/workflow.md) 和 [阅读协议](assets/reader.md)。当前逐章闭环已经连通；回顾由 Codex 在工作文档中记录，尚未提供独立自动卷回顾、完结检查或无人值守服务。三章固定样例验证流程，不能作为百万字或文学质量保证。


## v0.8：把创作任务和记忆接起来

新增总入口 `$specwriter`，由 Codex 按作者意图协调已有七个专项 Skills。新书默认 structured 工作流：先采用四份创作约定，再记录工作范围和接纳模式，完成结构化章纲后 prepare。完整步骤见 [创作流程](assets/workflow.md)。

`contract adopt` 将 Spec 快照保存在本书 SQLite 中，按章节选版本。改草稿 Spec 不会改变已采用约定；再次采用会使未完成上下文失效，不修改已接纳正文。`intent seed/save` 管理 intent.json 和生成的 intent.md。章纲绑定目标、场景、人物、POV、故事时间、必选状态/资源/事件/伏笔和揭露边界；未来计划不会入库。

参与人物和 POV 的关键状态、余额、显式依赖、上章末尾进入受保护上下文，预算装不下时拒绝准备；其余历史按预算检索。目标、角色认知和暂不揭露事项通过逐项 intent_checks 审阅。缺少已登记认知会提示核对，不能据此推断角色未知或已知。

`work authorize` 记录实际作者范围：draft 允许写和审阅，auto 才允许接纳；pause 阻止 prepare/commit，保留阅读/审阅。`resume` 从文件恢复下一步，不调用模型。Git 检查点包含约定和授权，政策单独变更也显示待备份。

旧书缺少 workflow 配置时保留旧流程，重新 init 更新未改动的 Skills；选择新流程后采用一次 contract。迁移不自动补写旧正文的稳定实体和事实，依赖缺失时须核对。API 的 legacy 选项仅用于旧流程和固定测试，不作为默认新书模式。

本轮验证包括协议回归和三章原创短篇流程演练；没有做付费 Qwen 建库、独立文学盲评或百万字验证。卷回顾、完结和更深入的记忆优化依后续阶段实施，源码仓库的 docs/v0.8-workflow-validation.md 保存详细验证范围。

## v0.7：模型诊断、备份状态和用量限制

在小说目录配置已有 Qwen 凭据与本地 BGE-M3（Ollama 须已安装并启动，执行 `ollama pull bge-m3` 获取模型）：

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag setup --python E:\projects\MyProjs\SpecWriter\.graphrag-venv\Scripts\python.exe --credentials E:\projects\MyProjs\SpecWriter\.env --preset qwen-bge-m3
node .specwriter/bin/specwriter.mjs doctor --models
node .specwriter/bin/specwriter.mjs doctor --models --probe
node .specwriter/bin/specwriter.mjs version status
node .specwriter/bin/specwriter.mjs memory budget configure --max-requests 100 --max-tokens 500000
node .specwriter/bin/specwriter.mjs memory budget show
```

替换示例 Python 与凭据文件路径。预设使用本机 `http://127.0.0.1:11434/v1` 的 `bge-m3`、1024 维；已有设置需要显式 `--reconfigure`。手工配置仍支持 `--embedding/--embedding-base/--embedding-dimensions`，不能与预设混用。推荐 `--credentials`；兼容旧 `--env-file`，但部分 Node 版本会在运行 CLI 前解析后者。

`doctor --models` 与 `memory graphrag diagnose` 默认不调用模型，`configured=true` 表示配置完整，只有 `--probe` 成功才返回 `ready=true`。探测会产生少量模型用量，单独返回 observedUsage，不进入 GraphRAG 作业账本。失败只显示状态、HTTP 错误码和修复建议，不回显模型正文或密钥。

启用版本管理后，`status.backup` 和 `version status` 持续显示最后检查点、待备份文件、记忆变化与上次失败；独立修改 Spec、计划、批注和阅读偏好后也可发现。失败后运行 `version save` 补存，成功清除失败记录；不重复接纳章节。`needsSave=null` 表示未启用或状态无法确认，查看 enabled/error 区分。

请求上限按每次 index/update/query 的非缓存模型调用尝试计数（含本地 embedding），token 阈值累计本书观测到的付费输入＋输出 token，本地 BGE 不计付费 token。金额阈值使用自行提供的价格，例如 `memory budget configure --max-cost 10 --prices prices.json`；单位是价格文件的 currency。配置命令替换整份限制，要保留多个上限须在同次提供。

费用与 token 在响应后才能确定，达到阈值阻止后续请求，已经在途的请求可能超过阈值；内部网络重试与供应商账单不由该调用计数证明。模型调用上限限制 GraphRAG 中间件调用尝试。未知用量默认阻止继续执行 token/金额限制，核对后可显式 `--unknown-usage allow`，但未知费用不会因此变成零。缺少当前模型价格时，金额限制会在调用前停止。

本书限额作业串行执行，缓存答案与已建索引仍可复用。崩溃后 `memory budget recover` 仅在主进程与记录的子进程都停止时解除锁；`memory budget clear` 关闭限制。预算保存在 `specwriter/memory-budget.json`，已整理的数值用量账本随书备份，原始 metrics、模型配置与索引不保存。恢复旧检查点只恢复当时的用量，检查点之后已经发生的费用不会撤销，须根据账单调整剩余额度。限制不包含 Codex 写作、诊断探测、本地硬件费用，也不是供应商账单硬上限。

## 小说版本、备份与恢复

在小说目录启用，之后每次接纳成功自动保存检查点：

```powershell
node .specwriter/bin/specwriter.mjs version init
node .specwriter/bin/specwriter.mjs version save --message "卷一完成"
node .specwriter/bin/specwriter.mjs version log
node .specwriter/bin/specwriter.mjs version status
node .specwriter/bin/specwriter.mjs version bundle --out E:\backups\my-book.bundle
node .specwriter/bin/specwriter.mjs version restore HEAD --to E:\novels\recovered
```

`restore` 也可用 `--bundle FILE` 在新机器恢复，不依赖原小说数据库。检查点保存正文、草稿、Spec、计划、审阅、批注和一致性 SQLite 副本；API Key、模型权重及 GraphRAG 索引不保存。恢复先验证再发布到新目录，并重新绑定当前安装的本地启动器；模型配置和索引需要重建。独立仓库在 `.specwriter/version/repository.git`，不会改动作者已有 Git 暂存区或推送远端。完整说明见 [版本与备份](assets/versioning.md)。本地 Git 用于回退，异地备份需要另存 bundle。

`versionNeedsSave=true` 表示章节已接纳但 Git 检查点未保存，修复后运行 version save；不要重复接纳。旧小说重新运行 init 更新未修改的 Skills 和协议，再 refresh 待写章节。

## 安装与初始化

可直接将本包的 [install.md](install.md) 交给 Codex 执行完整安装、依赖检查和使用验收；新凭据配置使用 [.env.example](.env.example)，已有 .env 则复用。源码根目录提供同一份安装指南。

仓库开发方式：

```powershell
npm install
npm run build
node packages/specwriter/dist/cli.js init E:\novels\my-book --name "我的小说"
```

需要全局终端命令时，在构建后运行 `npm link --workspace specwriter`。也可对本包 `npm pack`，安装生成的 tgz；本项目尚未发布到 npm。

初始化小说后，按下方“默认 Microsoft GraphRAG”步骤配置生成模型和 embedding 模型。第 1 章没有已接纳的历史正文，完成约定、授权及章纲后可准备；从第 2 章起默认 prepare 自动索引并检索。只体验离线模式时，在 init 命令添加 `--backend local`。

在 Codex 中打开刚创建的小说目录。init 安装项目级 `.agents/skills/specwriter*/SKILL.md`；已有会话可能需要重新打开或刷新技能发现。用户通过以下 Skills 或自然语言交互：

| Skill | 用途 |
| --- | --- |
| `$specwriter` | 开始或恢复创作，协调专项流程 |
| `$specwriter-explore` | 构思、讨论与解决剧情卡点 |
| `$specwriter-propose` | 建立创作约定、卷计划和有范围的工作包 |
| `$specwriter-write` | 记忆检索、章纲、正文、提取与审阅 |
| `$specwriter-review` | 连续性、约定和阅读体验审阅 |
| `$specwriter-revise` | 当前草稿或旧章修订及影响分析 |
| `$specwriter-commit` | 接纳正文与长期记忆 |
| `$specwriter-archive` | 工作包完成回顾与归档 |

例如：先让 Codex 用 propose 建立修仙悬疑小说的四份 Spec 和开篇计划，再用 write 写第一章，最后用 commit 接纳当前版本。斜杠命令 `/sw:*` 尚未实现；Codex 集成使用 Skills。

## CLI 及文档

小说根目录有本地启动器，无需依赖全局 PATH：

```powershell
node .specwriter/bin/specwriter.mjs resume --json
# Codex 按作者选择完善四份 Spec 后：
node .specwriter/bin/specwriter.mjs contract adopt --reason "作者已采用当前设定"
node .specwriter/bin/specwriter.mjs propose opening --title "开篇三章" --from 1 --to 3
node .specwriter/bin/specwriter.mjs work authorize opening --from 1 --to 3 --acceptance draft --reason "作者要求先审阅草稿"
node .specwriter/bin/specwriter.mjs intent seed 1 --work opening
# Codex 填写返回的 intent.json 后：
node .specwriter/bin/specwriter.mjs intent save 1 --work opening
node .specwriter/bin/specwriter.mjs prepare 1 --work opening
```

prepare 返回 intent、context、draft、delta、review 路径。新书 Codex 改章纲后先 intent save，再 `prepare 1 --work opening --refresh`，再完成正文、事实提取和审阅；`hash 1 --work opening` 提供正文、上下文和 intentHash。版本 2 契约要求证据 basis 和证据/遗漏/连续性三项有依据的审阅检查，修改章纲也会使旧候选失效。作者授权 auto 模式后才能接纳。随后：

新准备的上下文要求 Codex 在提取后运行 `review-requirements N --work ID`，逐项填写 critical_checks 的当前声明哈希、精确证据、判定和说明。位置、生死、境界、真实身份只能保留一个当前世界值；变更必须用 state_changes 匹配旧值。显式“以为/听说/梦见”不能仅靠 established 标签确立真相。检索 assessment 会报告缺失/未解析引用和已识别的状态/余额冲突；未通过的回答不进入续写素材，审阅需回到正式记忆和原文填写 retrieval_check。引用可定位仍不代表推断成立。

```powershell
# 仅在作者已审阅并明确要求接纳第一章后执行：
node .specwriter/bin/specwriter.mjs work authorize opening --from 1 --to 1 --acceptance auto --reason "作者已审阅并要求接纳第一章"
node .specwriter/bin/specwriter.mjs verify 1 --work opening
node .specwriter/bin/specwriter.mjs commit 1 --work opening
node .specwriter/bin/specwriter.mjs memory query "青铜钥匙" --at 1
node .specwriter/bin/specwriter.mjs memory query "小舟" --backend local --at 1 --hops 2
node .specwriter/bin/specwriter.mjs memory graph --at 1
node .specwriter/bin/specwriter.mjs doctor
```

CLI 默认输出 JSON；`--json` 还会将错误格式化为 JSON（写到 stderr）。详情见 `--help`。进度可从项目子目录恢复，或显式传 `--root`。

| 路径 | 职责 |
| --- | --- |
| `specwriter/config.yaml` | 项目配置和字符预算 |
| `specwriter/specs/*.md` | premise、world、characters、style 创作约定 |
| `specwriter/plans/` | 全书方向、滚动卷计划 |
| `specwriter/work/<id>/` | proposal、自动 tasks 和章节 intent/context/delta/review |
| `manuscript/drafts/` | 未接纳草稿和导入稿 |
| `manuscript/chapters/` | 已接纳正文的投影 |
| `specwriter/memory/views/` | 实体、事件、资源、当前状态、角色认知、伏笔、时间线、摘要投影 |
| `.specwriter/memory/writer.db` | 正文历史版本、正式事实、审阅、上下文、进度、采用约定和授权的正式数据源 |
| `.specwriter/graphrag/` | 默认后端配置、按版本隔离的正文/向量/社区报告与查询缓存（默认忽略） |
| `specwriter/archive/<id>/` | 工作文档快照与正文版本清单 |

使用 version save/bundle 保存一致的数据库副本及作者文档，不直接复制运行中的 writer.db。自动检查点需每本小说先 version init，当前只在章节接纳后触发；单独修改 Spec、计划、批注或阅读偏好后需要手工 save。生成的本地启动器指向安装位置；换电脑或移动安装后重新 init，作者修改的文件会被保留并报告。

## 记忆与修订

草稿和大纲不自动进入记忆。每条正式事实或状态变化需要逐字原文证据；候选事实和审阅绑定正文哈希、上下文哈希、基础版本。世界事实与角色认知分别保存；伏笔使用稳定 ID。

默认 prepare 使用 Microsoft GraphRAG 的查询结果，并保留正式事实、近期人物和两跳结构关系作为状态依据。检索回答以 kind=retrieval 写入 context；记录前缀/索引版本、receiptId 与回答哈希，verify/commit 复用并校验同一记录，不再次调用模型。预算按字符计算，不冒充模型 token，长回答明确截取；未选入上下文的正式记忆仍留在数据库中。原文索引使用 SQLite FTS5/BM25；`memory rebuild` 重建全文与本地图缓存，Microsoft 索引单独校验/建立。`memory query --backend local --hops` 支持 1–4 跳，`--holder` 额外限定角色 belief；world 与原文仍为作者视角。

记录契约参考 ainovel-cli 的章节事实体系与 InkOS 的正文证据状态投影，包含 `entities`、`narrative_events`、`resource_changes` 以及伏笔依赖和替代字段。已接纳的旧 delta 仍可重放，数据库内部 schema 版本为 3，新提取和审阅使用契约版本 2。已登记人物的名称/别名解析到稳定 ID，统一位置、关系、资源和 holder；同名冲突要求明确 ID。传闻、推测和想象使用 belief，不能建立世界真相。完整字段规则见 [记忆协议](assets/memory.md)。

## 默认 Microsoft GraphRAG

先在 Python >=3.11,<3.14 的独立虚拟环境安装 `graphrag==3.3.0`（随包 requirements-graphrag.txt 固定版本），再初始化官方配置：

当前本地 embedding 方案使用 BGE-M3：先 `ollama pull bge-m3`，再通过 setup 的 `--credentials FILE --provider qwen --embedding bge-m3 --embedding-base http://127.0.0.1:11434/v1 --embedding-dimensions 1024` 读取 Qwen 并配置本地向量。详见 [本地 BGE-M3 + Qwen](assets/memory.md#本地-bge-m3--qwen)。下面是使用云端 embedding 的可选配置：

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag setup --python "E:/novels/book/.graphrag-venv/Scripts/python.exe" --model gpt-4.1 --embedding text-embedding-3-large
```

setup 返回配置与 .env 路径，填写模型供应商凭据。默认 prepare/query 会调用配置的模型；缺少配置或模型失败时明确报错。离线检索通过 `memory query --backend local`，整本书切换离线模式通过 `memory configure --backend local`。没有 memory 字段的旧配置也默认 Microsoft，原先的显式 local 选择会保留。

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag export --at 12
node .specwriter/bin/specwriter.mjs prepare 13 --work middle-arc --query "林舟与石门、未兑现伏笔"
node .specwriter/bin/specwriter.mjs memory query "这一卷有哪些未兑现的承诺？" --at 12 --method global
```

默认配置为 `memory: { backend: microsoft-graphrag, method: local, autoIndex: true, indexRetention: 2 }`。已有索引与同一查询回答会复用，新前缀从版本/配置一致的较早前缀复制索引，调用官方 update 增量提取；无有效父索引时全量建立。全文加载、向量复制和社区合并仍有成本。默认保留当前版本链最近 2 个索引及待写章节依赖，可用 `memory configure --backend microsoft-graphrag --retain 0` 关闭自动清理。关闭自动索引用 `--auto-index false`，之后需手工 index。

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag status --at 12
node .specwriter/bin/specwriter.mjs memory graphrag recover --at 12
node .specwriter/bin/specwriter.mjs memory graphrag index --at 12 --rebuild
node .specwriter/bin/specwriter.mjs memory graphrag prune --keep 2 --dry-run
```

status 校验就绪状态并展示阶段；recover 只移除已停止进程的锁。进度写到 stderr，Ctrl+C 取消操作，失败重试清除未完成派生文件。prune 清理索引、保留正文与查询记录，被清理的历史前缀再次使用需重新索引。查询引用从 parquet 追溯到正文版本和逐字片段；无法映射的引用明确列出，语义仍需核对。

每个前缀/版本使用独立语料、缓存、LanceDB 和社区报告；只有指定边界内的已接纳原文进入索引。后续章节不影响已有旧章前缀；旧章重写生成新快照，下次准备自动索引。校验输入、配置、提示词与索引产物，拒绝过期或未完成索引。回答标记 advisory，不自动成为正式事实。详细安装、恢复和约束见 [记忆协议](assets/memory.md)，模式参数见 [官方 CLI](https://microsoft.github.io/graphrag/cli/)。

TypeScript 默认入口是异步 `new WriterMemory(project).prepare/query`；同步 Project API 管理正式状态和结构化图，默认 prepare 只消费已经生成的检索记录。

修订旧章通过新工作包 prepare，再重新提取、审阅、提交。之后后续正文保留，派生记忆保守标为 stale；从第一个 stale 章节顺序核对并重新提交。`memory --at` 不能跨过尚未协调的边界。

直接修改正式章节后，普通 sync 会拒绝覆盖。`sync --capture` 先把修改保存到 `manuscript/drafts/imported/`，再恢复已接纳正文；将导入稿放到修订工作包重新接纳。`prepare --refresh` 保留正文和 intent，备份并重置过期的提取/审阅结果。

接纳正文与事实在同一 SQLite 事务中完成。文件投影在事务之后生成；若 commit 返回 `projectionNeedsSync: true`，数据库已经接纳，用 sync 恢复文件，不要再次提交。archive 关闭已完成工作包，不把计划变为事实；原工作目录保留，归档快照不会随后续修订改写。

## 记忆实验与用量

支持从现有 `.env` 的 `LLM_PROVIDERS` 读取 Qwen 配置，embedding 独立使用本地 Ollama BGE-M3；参见 [本地配置步骤](assets/memory.md#本地-bge-m3--qwen)。本地向量化在用量中标记 `local: true`，API 费用为零，Qwen 费用仍需提供单价。

源码仓库提供可选真实连接检查（会调用配置的 Qwen API）：

```powershell
node packages/specwriter/examples/local-memory-smoke.mjs NEW_BOOK_ROOT ENV_FILE GRAPHRAG_PYTHON
```

只对一章人工短文建索引并查询，结果存于 `connection-result.json`；它验证连接，不代表长篇小说质量或成本收益。运行前需 `ollama pull bge-m3` 并启动本地服务。

运行 `specwriter benchmark run` 可在独立目录比较全量建库、缓存、增量更新和结构化检索。默认离线，不调用模型；真实实验需要显式 `--mode live --provider 小说根目录 --max-operations N`。`memory usage` 报告 GraphRAG 请求用量，缺失数据保留未知，`--prices FILE` 使用用户提供的单价估算费用。详见 [实验与评分说明](assets/benchmark.md)。

## 小说阅读、批注与交付

在小说目录运行：

```powershell
node .specwriter/bin/specwriter.mjs read
node .specwriter/bin/specwriter.mjs read --draft --work opening
node .specwriter/bin/specwriter.mjs export --format html
```

read 自动打开浏览器；服务仅绑定本机，Ctrl+C 停止。目录支持正式/草稿切换、连续阅读、阅读进度、字号、行距、夜间主题、版本对照和段落批注。偏好与各范围进度存于 `.specwriter/reader/preferences.json`，服务重启、随机端口改变后可恢复；正文改动后不沿用旧滚动偏移。Codex 写完后刷新正文即可看到新内容，不要求 GraphRAG 或模型凭据。

批注绑定正文版本与精确引用。按“复制给 Codex”粘贴修订请求，或直接让 Codex 使用 feedback list 读取意见；原文改变时旧批注标为过期。阅读器与 CLI 均可导出 TXT/Markdown/独立 HTML 到 exports/，只包含连续有效的正式章节；草稿与需要重审的后续章节排除。详见 [阅读协议](assets/reader.md)。现有小说重新运行 init 会安装新的阅读协议和更新未被作者改写的 Skills，保留正文与创作约定。

## 验证与当前范围

```powershell
npm test
npm run check
npm run demo
npm run demo:long
npm run reader:demo
```

demo 使用内置示例正文，不调用 AI，并输出一个可检查的临时小说项目路径。

demo:long 验证 24 章人物别名、资源、因果、伏笔推进/兑现，第 5 章返修后逐章协调、批注、阅读偏好与正式导出。共 44 次接纳，不调用模型；这是工作流样本，不是百万字或文学质量基准。

reader:demo 生成有两章正式正文、一章草稿和示例批注的临时小说，打印本地阅读地址，不调用模型；打开地址预览，Ctrl+C 停止服务。

可选兼容检查：`node packages/specwriter/examples/graphrag-smoke.mjs PATH/TO/PYTHON` 使用官方 GraphRAG 3.3.0 执行 init、标准/增量配置 dry-run、query/update 参数检查、原生增量文档差分/合并，以及 parquet 引用映射（含 CRLF 原文）。不执行真实模型索引/查询；完整问答需要有效供应商凭据。

已有小说重新 init 安装新版 Skills 与协议；作者改过的 Skills 保留并报告冲突。未完成章节先 prepare --refresh，再按版本 2 重新提取和审阅；已接纳历史保留。图计算版本为 kernelVersion 3，旧派生 Microsoft 索引需要为新快照重新建立。

当前是可运行 MVP：Microsoft GraphRAG 默认用于准备和查询，本地结构化记忆负责正式状态依据并提供显式离线模式；本地阅读器负责正文展示、批注与交付，没有独立写作 Agent、MCP 服务或直接修改正文的 Web 编辑器。证据校验能确认引用存在，不能机械证明语义蕴含或文学质量；这些由 Codex 审阅。故事内时间暂为文本，不自动推断复杂倒叙关系。百万字规模的质量与性能尚未基准验证。

复用来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
