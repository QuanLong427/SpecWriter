# SpecWriter

面向 Codex 的本地长篇小说写作工作流。SpecWriter 管理创作约定和滚动计划；WriterMemory 维护从正式正文提取的有来源、可追溯、带章节边界的长期记忆。

要求 Node.js 24+。Node 24 的 `node:sqlite` 会提示 experimental；当前实现与测试使用 Node 24.14。WriterMemory 默认使用 Microsoft GraphRAG，需要 Python >=3.11,<3.14、GraphRAG 3.3.x 和模型配置。显式 local 模式的检索不调用模型。

## 安装与初始化

仓库开发方式：

```powershell
npm install
npm run build
node packages/specwriter/dist/cli.js init E:\novels\my-book --name "我的小说"
```

需要全局终端命令时，在构建后运行 `npm link --workspace specwriter`。也可对本包 `npm pack`，安装生成的 tgz；本项目尚未发布到 npm。

初始化小说后，按下方“默认 Microsoft GraphRAG”步骤配置生成模型和 embedding 模型。第 1 章没有已接纳的历史正文，可以直接准备；从第 2 章起默认 prepare 自动索引并检索。只体验离线模式时，在 init 命令添加 `--backend local`。

在 Codex 中打开刚创建的小说目录。init 安装项目级 `.agents/skills/specwriter-*/SKILL.md`；已有会话可能需要重新打开或刷新技能发现。用户通过以下 Skills 或自然语言交互：

| Skill | 用途 |
| --- | --- |
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
node .specwriter/bin/specwriter.mjs status --json
node .specwriter/bin/specwriter.mjs propose opening --title "开篇三章" --from 1 --to 3
node .specwriter/bin/specwriter.mjs prepare 1 --work opening --query "林舟、废井、青铜钥匙"
```

prepare 返回 intent、context、draft、delta、review 路径。Codex 完成正文、事实提取和审阅；`hash 1 --work opening` 提供当前哈希供新提取结果使用，随后：

```powershell
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
| `.specwriter/memory/writer.db` | 正文历史版本、候选事实、审阅、上下文、进度的正式数据源 |
| `.specwriter/graphrag/` | 默认后端配置、按版本隔离的正文/向量/社区报告与查询缓存（默认忽略） |
| `specwriter/archive/<id>/` | 工作文档快照与正文版本清单 |

备份整个小说目录，特别是 `writer.db`；数据库和草稿不要放进忽略规则。数据库 WAL/SHM 是临时运行文件，退出 CLI 后再备份或提交版本控制。生成的本地启动器指向安装位置；换电脑或移动安装后重新 init，作者修改的文件会被保留并报告。

## 记忆与修订

草稿和大纲不自动进入记忆。每条正式事实或状态变化需要逐字原文证据；候选事实和审阅绑定正文哈希、上下文哈希、基础版本。世界事实与角色认知分别保存；伏笔使用稳定 ID。

默认 prepare 使用 Microsoft GraphRAG 的查询结果，并保留正式事实、近期人物和两跳结构关系作为状态依据。检索回答以 kind=retrieval 写入 context；记录前缀/索引版本、receiptId 与回答哈希，verify/commit 复用并校验同一记录，不再次调用模型。预算按字符计算，不冒充模型 token，长回答明确截取；未选入上下文的正式记忆仍留在数据库中。原文索引使用 SQLite FTS5/BM25；`memory rebuild` 重建全文与本地图缓存，Microsoft 索引单独校验/建立。`memory query --backend local --hops` 支持 1–4 跳，`--holder` 额外限定角色 belief；world 与原文仍为作者视角。

记录契约参考 ainovel-cli 的章节事实体系与 InkOS 的正文证据状态投影，新增可选 `entities`、`narrative_events`、`resource_changes` 以及伏笔依赖和替代字段。旧 delta 仍可重放，数据库自动迁移到 schema 2。实体有稳定 ID 和别名，事件有参与者、地点、因果，资源核对期初与期末。完整字段规则见 [记忆协议](assets/memory.md)。

## 默认 Microsoft GraphRAG

先在 Python >=3.11,<3.14 的独立虚拟环境安装 `graphrag==3.3.0`（随包 requirements-graphrag.txt 固定版本），再初始化官方配置：

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag setup --python "E:/novels/book/.graphrag-venv/Scripts/python.exe" --model gpt-4.1 --embedding text-embedding-3-large
```

setup 返回配置与 .env 路径，填写模型供应商凭据。默认 prepare/query 会调用配置的模型；缺少配置或模型失败时明确报错。离线检索通过 `memory query --backend local`，整本书切换离线模式通过 `memory configure --backend local`。没有 memory 字段的旧配置也默认 Microsoft，原先的显式 local 选择会保留。

```powershell
node .specwriter/bin/specwriter.mjs memory graphrag export --at 12
node .specwriter/bin/specwriter.mjs prepare 13 --work middle-arc --query "林舟与石门、未兑现伏笔"
node .specwriter/bin/specwriter.mjs memory query "这一卷有哪些未兑现的承诺？" --at 12 --method global
```

默认配置为 `memory: { backend: microsoft-graphrag, method: local, autoIndex: true }`。已有且校验通过的索引及同一查询回答会复用，首次使用新前缀会建立索引。运行 `memory configure --backend microsoft-graphrag --auto-index false` 可关闭自动索引，之后需手工 `memory graphrag index --at N`。

每个前缀/版本使用独立语料、缓存、LanceDB 和社区报告；只有指定边界内的已接纳原文进入索引。后续章节不影响已有旧章前缀；旧章重写生成新快照，下次准备自动索引。校验输入、配置、提示词与索引产物，拒绝过期或未完成索引。回答标记 advisory，不自动成为正式事实。详细安装、恢复和约束见 [记忆协议](assets/memory.md)，模式参数见 [官方 CLI](https://microsoft.github.io/graphrag/cli/)。

TypeScript 默认入口是异步 `new WriterMemory(project).prepare/query`；同步 Project API 管理正式状态和结构化图，默认 prepare 只消费已经生成的检索记录。

修订旧章通过新工作包 prepare，再重新提取、审阅、提交。之后后续正文保留，派生记忆保守标为 stale；从第一个 stale 章节顺序核对并重新提交。`memory --at` 不能跨过尚未协调的边界。

直接修改正式章节后，普通 sync 会拒绝覆盖。`sync --capture` 先把修改保存到 `manuscript/drafts/imported/`，再恢复已接纳正文；将导入稿放到修订工作包重新接纳。`prepare --refresh` 保留正文和 intent，备份并重置过期的提取/审阅结果。

接纳正文与事实在同一 SQLite 事务中完成。文件投影在事务之后生成；若 commit 返回 `projectionNeedsSync: true`，数据库已经接纳，用 sync 恢复文件，不要再次提交。archive 关闭已完成工作包，不把计划变为事实；原工作目录保留，归档快照不会随后续修订改写。

## 验证与当前范围

```powershell
npm test
npm run check
npm run demo
```

demo 使用内置示例正文，不调用 AI，并输出一个可检查的临时小说项目路径。

可选兼容检查：`node packages/specwriter/examples/graphrag-smoke.mjs PATH/TO/PYTHON` 使用官方 GraphRAG 3.3.0 执行 init、离线配置 dry-run 和 query 帮助检查。它关闭模型连接验证，不执行真实索引/模型查询；完整问答需要有效供应商凭据。

当前是可运行 MVP：Microsoft GraphRAG 默认用于准备和查询，本地结构化记忆负责正式状态依据并提供显式离线模式；没有独立写作 Agent、MCP 服务或 Web 编辑器。证据校验能确认引用存在，不能机械证明语义蕴含或文学质量；这些由 Codex 审阅。故事内时间暂为文本，不自动推断复杂倒叙关系。百万字规模的质量与性能尚未基准验证。

复用来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
