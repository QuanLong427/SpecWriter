# SpecWriter 架构与数据边界

## 产品边界

用户在 Codex 内讨论、规划、写作和审阅。项目级 Skills 将创作动作编排成对本地 CLI 的调用；CLI 不运行另一个写作 Agent。WriterMemory 负责事实契约、版本、检索和恢复，默认使用 Microsoft GraphRAG 调用配置的模型完成索引和检索。

```text
用户的创作意图
    ↓
Codex + 项目级 SpecWriter Skills
    ├── 创作约定 / 滚动计划 / 章纲 / 正文 / 审阅
    └── SpecWriter CLI / 可复用 TypeScript API
                ↓
          WriterMemory
          ├── SQLite：正式正文、历史版本、delta、review、context、工作状态
          ├── FTS5：中文分词 + 汉字二元词组 + BM25 原文索引
          ├── 本地图：实体别名、事件因果、关系、认知、资源、伏笔依赖；多跳检索
          ├── 默认 Microsoft GraphRAG：前缀隔离的向量与社区摘要、带哈希的查询缓存
          └── 可重建投影：正文 Markdown、实体、事件、资源、状态、认知、伏笔、时间线、摘要
```

旧网页与后端不参与该包。第一版固定工作流，不实现通用工作流引擎、模型调度平台或多 Agent 服务。

## 四种信息

1. Spec 是作者采用的创作约定，包含硬约束、创作目标、开放空间。
2. Plan 是未来创作安排，允许根据完成的正文滚动调整。
3. 草稿是尚未接纳的正文，可能不满足约定，也可能有互相排斥的多个版本。
4. Memory 是当前正式版本的正文证据所确立的信息；世界事实、人物认知、状态变更、关系和伏笔分别处理。

Spec 与 Plan 可供 Codex 创作，但不能成为事件发生的证据。模板默认草案，由作者与 Codex 明确采用范围；CLI 不判断一条文学约定是否足够成熟。

## 工作流与状态

`propose` 创建章节范围明确的工作包。`prepare` 固定 Spec/Plan/作者意图、已同步记忆、正文来源、基础版本和全局 generation；输出 context、intent、草稿与空提取/审阅文件。草稿由 Codex 填写。

正文完成后，Codex 根据当前正文提取带逐字引用的候选事实，并对连续性、约定和阅读体验进行定性审阅。`verify` 校验 schema、原文引用、基础版本、上下文和正文哈希、状态旧值、伏笔操作以及未解决的阻塞项；不能证明语义蕴含或文学质量。

`commit` 在 `BEGIN IMMEDIATE` 事务内重新校验并写入不可变 revision、正式 chapter 指针、中文 FTS 索引、图快照及 generation。事务串行化并发接纳；准备时版本变化会导致后续候选失效。提交后单独生成文件投影，失败返回已提交状态和 sync 提示。

`archive` 要求整个范围已接纳且记忆同步，保存工作文档快照和正式版本清单；不改变事实内容，也不把计划事件转成记忆。工作原目录保留，数据库工作状态是权威，归档快照保持当时内容。

## 时间与修订

事实保存来源章节、来源版本、引用及自动计算的原文行号。当前状态变化记录 `validFromChapter`、`validUntilChapter`；这些是正文揭露范围，不是故事内时间。故事内时间由 timeline 的文本记录，复杂倒叙的因果顺序暂由 Codex 判断。

准备第 N 章仅重放第 1 至 N−1 章的正式版本。按章节查询的原文、事实、人物认知、伏笔和摘要均不超过请求边界。FTS 索引包含历史版本，但查询连接当前正式 chapter 指针，并排除 stale 章节；被替换版本的原文不会混入当前检索。

修改旧章接纳后，所有后续章节保守标 stale，后续正文和历史版本保留。记忆只重放连续已同步前缀；逐章重新核对正文、提取、审阅和提交后恢复后续记忆。第一版不做细粒度依赖传播，也不承诺自动修复后续正文。

人物认知单独保存 holder。本地结构化检索返回世界事实，指定 holder 时额外返回该角色的认知；原文和 Microsoft 语义检索仍是作者视角。需要 holder/hops 时，CLI 显式选择 --backend local。Skills 必须根据当前叙事视角约束信息使用。

## 上下文与扩展

完整事实永久保存在章节 revision 中，读取时重放。上下文默认包含 Microsoft GraphRAG 检索建议，正式事实按查询匹配、两跳关系、近期人物及来源章节排序，在字符预算内选入；`memorySelection` 记录选入数量和完整数量，retrieval 记录前缀/索引/回答哈希与本地关系路径。选入后的原文证据保持不变，模型回答明确是 advisory；未选中信息仍可通过 query/show 追加检索。

原文只在接纳时分词建索引；FTS5/BM25 不需要每次重新扫描全文。该索引可由 immutable revisions 重建。本地图包含实体、值、事件、伏笔、资源节点和带证据的关系边，默认两跳、可查询 1–4 跳。实体稳定 ID 与别名用于种子召回，冲突别名不会自动合并。belief 在遍历之前按 holder 过滤。图快照由前缀章节/版本/正文与 delta 哈希确定，缓存最多 16 个派生快照，任何早期前缀都可重建；数据库 schema 1 自动迁移到 2。

Microsoft GraphRAG 3.3.x 是默认检索后端：setup 使用官方 init，export 从 SQLite 导出指定已接纳前缀正文，index/query 使用独立 input/output/cache/vector_store/prompts。每个前缀版本有独立社区报告，禁止先索引未来再过滤查询。完成索引后写 ready 标记和语料/配置/提示词/产物校验值，操作结束再次检查正式版本，拒绝并发返修产生的过期结果。模型回答是作者视角的 advisory，不进入事实源。字段矩阵、安装和操作见 [记忆协议](../packages/specwriter/assets/memory.md)。

`WriterMemory.prepare/query` 是异步默认入口。prepare 先用短事务检查章节、工作状态、作者输入与 generation，随后在事务外按配置 autoIndex 建立/复用前缀索引并取回查询回答，最后在短事务中再次检查初始输入指纹，编译上下文与章节文件。首章前缀为空，不调用 Python 或模型；失败不静默回退。显式 local 模式跳过 Microsoft，仍使用正式状态与本地检索。

查询记录的缓存键含 snapshotId、provider version、configHash、outputHash、query 和 method；正文/配置/索引变化使缓存失效。context 的 kind=retrieval 来源保存预算内的回答片段，完整回答保留在私有查询记录。verify/commit 只检查同一记录与索引的完整性、重算确定性上下文，不重新生成答案，不在 SQLite 事务内调用模型。新项目和缺少 memory 配置的旧项目默认 Microsoft；显式 local 配置保留。切换配置后旧候选需 refresh 并重新提取审阅。

## 文件与恢复

正式数据源为 SQLite，Markdown 是投影。普通 sync 修复缺失/过期投影，但拒绝覆盖未接纳的正文直接编辑。sync --capture 保存编辑稿后恢复正式投影，作者通过新修订工作包重新接纳。已提交但尚未生成的正文通过旧投影哈希及数据库历史校验恢复。

Skills 安装使用生成内容哈希记录所有权，保留手工修改文件。AGENTS.md 只追加带标记的项目段，不替换已有规则。工作 ID、章节路径与现有目录链接均做路径边界检查。

## 阅读、反馈与导出

NovelReader 从 SQLite 的正式 revision 读取正文，按 trustedPrefix 标记需要重审的后续章节，工作包草稿显式切换。目录与正文读取共享短事务，避免外部 Codex 并发接纳时混合正文和版本。阅读和导出不调用 GraphRAG、不修改正式正文或记忆。

本地 HTTP 服务仅绑定 127.0.0.1，静态资源使用白名单，不暴露项目目录；Host、Origin、Fetch Metadata 和随机会话请求头限制跨站访问。正文与批注使用 textContent 或 HTML 转义，不执行作者文字中的 HTML/脚本。模型设置与凭据不进入阅读接口或交付文件。

批注每条保存为 specwriter/feedback/<UUID>.json，绑定正文哈希、章节 key、revision、原文引用和字符偏移，保存时校验当前版本；版本变化后标 outdated，保留原意见。用户把修订请求带回 Codex，Skills 通过 feedback CLI 获取同一记录并核对版本，修订继续使用原有 prepare/verify/commit 闭环。

正式交付按单次事务快照导出连续有效章节为 TXT/Markdown/独立 HTML，附版本清单。生成文件被手工修改时拒绝覆盖。阅读器保存作品至 exports/ 并下载副本，使内嵌浏览器也有可定位的产物。页面是原生 HTML/CSS/JS，无新增运行依赖，维护独立阅读偏好和进度。

尚未实现：自动文学质量评估、导入整本外部小说的自动提取、独立写作 Agent、MCP、直接编辑正文的 Web UI、EPUB、复杂故事时间推理、百万字质量/性能基准。通过集成测试验证的是记忆与文件的机械一致性，不代表文学表现已获验证。
