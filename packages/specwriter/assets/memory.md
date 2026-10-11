# WriterMemory 记录与 GraphRAG 协议

Microsoft GraphRAG 是默认检索后端。WriterMemory 继续管理正式事实、状态、认知、章节和版本。只有显式选择 `memory.backend: local` 才使用离线检索；配置或模型调用失败不会静默切换。

## 记录什么

记忆从已接纳正文重放，候选提取放在 memory-delta.json。每条新增记录必须有当前草稿中逐字连续的 evidence.quote。引用存在由 CLI 检查，引用是否支持所提事实由 Codex 审阅。没有数字、因果或身份依据时留空，不能猜测补全。

| 内容 | 字段 | 使用方式 |
| --- | --- | --- |
| 章节回顾、出场人物 | title / summary / characters | 恢复进度和近期上下文 |
| 已发生的重要动作 | key_events | 带来源的情节记忆；兼容旧提取契约 |
| 人物、地点、道具、势力、概念 | entities | 稳定 ID、类型、name、aliases、description，避免同名误合并 |
| 事件参与者、场所、故事时间、明确原因 | narrative_events | 跨章事件图；故事内时间和揭露章节分别记录 |
| 可并存事实 | facts | subject / predicate / object；world 与 belief 分开 |
| 位置、生死、伤势、能力、情绪等当前属性 | state_changes | old_value 前置校验，当前值替换，保留历史 |
| 人际关系变化 | relationship_changes | 当章正式关系版本，图中连接两个人物 |
| 角色获知、误信、怀疑的信息 | belief facts / state_changes / narrative_events | 明确 holder；不转成世界真相 |
| 钱、灵石、次数、数量等 | resource_changes | opening + change = closing，opening 必须匹配已有余额 |
| 埋下、推进、延期、兑现或取代的承诺 | foreshadow_updates | 稳定 ID、状态、预期兑现目标、依赖与替代关系 |
| 故事内时间 | timeline_events | 保留原文时间表述，不从章节编号推测时间 |
| 首次登场角色 | cast_intros | 保留原角色概述契约；稳定身份另登记 entities |

Spec、卷纲、作者意图和章纲单独保留为创作输入，不能变成已发生事实。预期兑现目标 expected_payoff 是未兑现的承诺描述，不能当作已经发生的事件。

## 结构化事件和实体

实体 ID 使用 `lin-zhou` 这样的稳定名称（小写字母起始，允许数字、横线、下划线），同一角色改称号仍用相同 ID；别名仅从正文确立的信息登记。版本 2 将已登记的名称/别名解析成稳定 ID，统一状态旧值、资源余额、关系与 holder；同一章用两个别名更新同一属性或资源会被拒绝。重名/冲突别名必须改用明确 ID，不能自动合并。尚未登记的引用保留原文字面值；要避免同一角色拆成两份记忆，应先登记 entities。已接纳版本 1 的记录不重写，后续版本 2 更新会查找其已登记身份；历史中已存在多个矛盾状态须显式修订。

```json
{
  "entities": [{
    "id": "lin-zhou", "name": "林舟", "type": "character",
    "aliases": ["小舟"], "description": "本章出场人物",
    "evidence": {"quote": "白衡叫了一声小舟，林舟回过头来。", "basis": "established"}
  }],
  "narrative_events": [{
    "id": "break-seal", "description": "林舟打破封印",
    "story_time": "次日黎明", "participants": ["lin-zhou"],
    "location": "山洞", "causes": [], "scope": "world", "holder": null,
    "evidence": {"quote": "次日黎明，林舟在山洞打破封印。", "basis": "established"}
  }],
  "resource_changes": [{
    "entity": "lin-zhou", "resource": "灵石", "opening": 10, "change": -3, "closing": 7,
    "evidence": {"quote": "林舟有十枚灵石，花掉三枚，还剩七枚。", "basis": "established"}
  }]
}
```

以上是字段片段，必须填入 prepare 生成的完整 delta，并绑定当前正文/context 哈希。事件 ID 不能重复；causes 必须指向此前或同章存在的事件，因果链不能成环。world 事件不能用 belief 事件充当真实原因，两个 belief 事件串联必须属于同一 holder。角色因为误信某事而采取真实行动时，可以记录行动为 world，误信为 belief；在描述和证据中说明动机，不能把误信内容记作真的发生过。

resource_changes 每章对同一 entity/resource 最多一项，合并本章总增减。首次建立余额的 opening 也需正文依据。该账本保存当前余额，完整开销明细和历史由章节 delta 保留。

伏笔可附 `expected_payoff`（非空字符串）、`depends_on`（伏笔 ID 数组）。`supersede` 必须给 `superseded_by`，替代项须已存在或本章 plant；所有依赖/替代链禁止环。resolved/superseded 不能继续 advance。每章同一伏笔最多一次操作，需要先 plant 再在后续章取代。

## 本地结构化记忆与离线检索

SQLite 保存正式版本和派生图快照；中文 BM25 召回原文，实体名称/别名召回种子，图遍历展开 1–4 跳，返回关联事实、事件、伏笔、资源与引用证据。这些记录仍是默认上下文中的正式状态依据。显式离线检索不需要 API Key：

```text
memory query "小舟" --backend local --at 12 --hops 2
memory query "师父" --backend local --at 12 --holder 林舟
memory graph --at 12
memory rebuild
```

默认只有 world 图边和事件；holder 额外开放对应人物的 belief，过滤在遍历之前执行。返回的 world 与原文仍是作者可知信息。它不等于“林舟只知道这些”，创作时仍须核对认知事实与叙事视角。

结构化图由已接纳 delta 构建，保留来源章节、正文版本、quote 和行号。两跳关系选择帮助保留关键状态，与 Microsoft 的语义检索结果一起进入上下文。永久切换离线模式可运行 `memory configure --backend local`，或初始化时加 `--backend local`；恢复默认用 `memory configure --backend microsoft-graphrag`。更改配置会使既有草稿上下文失效，需要 prepare --refresh 后重新提取审阅。

## 默认 Microsoft GraphRAG

适配器支持 GraphRAG 3.3.x，建议固定 3.3.0，Python 要求 >=3.11,<3.14。在独立虚拟环境安装。npm 包包含 TypeScript 编排器，Python 依赖通过随包的 requirements-graphrag.txt 安装；不会自动修改系统 Python。

```powershell
python -m venv .graphrag-venv
.graphrag-venv/Scripts/python.exe -m pip install "graphrag==3.3.0"
node .specwriter/bin/specwriter.mjs memory graphrag setup --python "E:/novels/book/.graphrag-venv/Scripts/python.exe" --model gpt-4.1 --embedding text-embedding-3-large
```

setup 调用官方 init，返回 provider/settings.yaml 和 provider/.env 路径，不调用模型。根据模型供应商填写该 .env 和 settings.yaml。重复 setup 保留已有设置；更换模型请编辑返回的配置文件。index/query 会调用配置的 API，因此按实际模型产生费用。

### 本地 BGE-M3 + Qwen

使用已安装的 Ollama 运行 BGE-M3 稠密向量模型，Qwen 单独负责图谱提取、摘要与回答。先执行 `ollama pull bge-m3`，确认本地 Ollama 服务可访问，再配置小说：

```powershell
specwriter memory graphrag setup --python "E:/projects/MyProjs/SpecWriter/.graphrag-venv/Scripts/python.exe" --env-file "E:/projects/MyProjs/SpecWriter/.env" --provider qwen --embedding bge-m3 --embedding-base http://127.0.0.1:11434/v1 --embedding-dimensions 1024
```

`--env-file` 支持 `LLM_PROVIDERS` JSON，其中供应商需要 `protocol: openai_chat_completions`、`api_url`、`api_key`、`models`；只有一个不同模型时自动选择，否则显式加 `--model`。也支持 `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL`。密钥只写入该小说私有 provider/.env，不修改来源文件，不打印密钥；本地 embedding 使用独立占位密钥。setup 不验证服务或调用模型，index/query 才会实际调用。

本地服务参数必须指向回环地址，并显式给出维度；BGE-M3 设置为 1024，覆盖三个向量索引的维度，避免沿用 GraphRAG 的 3072 默认值。正文、实体、社区摘要使用独立 index_name，防止覆盖；重复表名会在索引调用前拒绝。已有配置需要加 `--reconfigure` 才会覆盖，再用 `memory graphrag index --at N --rebuild` 重建旧索引。该配置先使用稠密检索，不自动启用 BGE 的稀疏检索、多向量或 reranker。

BGE-M3 模型的最大输入为 8192 token，但 Ollama 实际上下文长度还受服务/模型参数限制；可用 `ollama ps` 查看已加载长度，不要把模型上限当作部署参数。长篇小说仍须分块索引。Windows 启动器为文件存储使用长路径，为 LanceDB 使用同一目录的 Windows 短路径名，所有文件仍位于对应快照；卷不支持短路径且位置过长时，在模型调用前提示改用较短小说目录。

`memory usage` 中本地 embedding 会标记 `local: true`，其 token 数反映本地工作量，API 费用为零；不包括硬件、电费。Qwen 未提供价格时仍显示未知费用。本地 embedding 不会把图谱生成变为离线步骤。固定 Ollama 模型版本，并在替换模型权重后重建索引；模型名相同不代表向量空间相同。

当前实际连接检查中，索引用量可以完整记录；GraphRAG 查询内部的流式生成未返回完整 Qwen usage，查询标记 partial，不能将缺失的 tokens 当成零，也不能据此计算完整总费用。

新项目配置，以及没有 memory 字段的旧项目，默认按以下设置运行：

```yaml
memory:
  backend: microsoft-graphrag
  method: local
  autoIndex: true
  indexRetention: 2
```

`prepare N` 自动取回截至 N−1 章的正式原文前缀：已有且校验通过的索引直接复用；否则选取同一正文版本链上最长的、配置一致的较早前缀，复制 output/cache 后调用官方 `graphrag update --method standard`，只对新增文档进入增量提取。没有有效父索引时建立标准索引。全文仍需加载，合并、向量复制与社区工作仍有成本，不保证每章索引恒定耗时。第一章没有历史正文，标记 empty 并跳过 Python/模型调用。不提供 query 时使用“事件、人物、状态、认知与未兑现伏笔”的续写检索目标。`memory query` 同样自动使用 Microsoft，支持 `--method global` 等模式。

```text
prepare 13 --work middle-arc --query "林舟与白衡的冲突、石门和未兑现伏笔"
memory query "本卷主要矛盾是什么？" --at 12 --method global
memory configure --backend microsoft-graphrag --auto-index false
```

autoIndex=false 时需要先手工 index；未完成索引会报错。默认流程不会使用失败或被篡改的索引，也不会暗中回退到离线查询。模型调用在 SQLite 事务外完成，结束后再次核对正式版本、作者约定和配置，防止并发修改混入准备结果。

```text
memory graphrag export --at 12
memory graphrag index --at 12
memory graphrag query "本卷主要矛盾与未兑现承诺是什么？" --at 12 --method global
memory graphrag query "林舟与白衡有哪些联系？" --at 12 --method local
```

export 可单独离线执行。每个索引位于 `.specwriter/graphrag/snapshots/<snapshotId>/`，只导出指定边界内已接纳正文。草稿、Spec、计划、未来章节和 stale 内容都不会导出。input、output、cache、LanceDB、prompts、日志按快照隔离；禁止共享包含未来内容的索引后再做章号过滤。provider 的 .env 会复制到私有快照供官方 CLI 使用；整个 graphrag 目录默认被其 .gitignore 排除。不要把密钥粘进 Spec 或对话。

索引完成后才写 ready.json，记录语料、配置、提示和产物校验值，以及父快照、标准/增量模式、新增章节数和耗时。query 拒绝不完整、被修改或版本不匹配的索引；操作前后核对正文版本，避免并发修订后返回过期答案。新章不会改变父索引的向量/社区报告；旧章重写生成新 snapshotId，只能复用返修点之前一致的历史，禁止复制含未来内容的索引。更改模型/提示词后旧索引明确报错，使用 `memory graphrag index --at N --rebuild` 重建。

```text
memory graphrag status --at 12
memory graphrag recover --at 12
memory graphrag index --at 12 --rebuild
memory graphrag prune --keep 2 --dry-run
memory graphrag prune --keep 2
memory configure --backend microsoft-graphrag --retain 0
```

索引阶段进度输出到 stderr，stdout 保持最终 JSON；job.json 保留 starting/cloning/indexing/ready/failed 元数据。锁记录 Node 主进程和 Python 子进程 PID。Ctrl+C 终止子进程后才释放锁，未完成索引不标 ready，重试会清除该子快照的未完成派生文件。recover 仅在确认已记录的主进程和子进程都已停止时移除锁，运行中的操作拒绝恢复。旧版只有主进程 PID 的残留锁，需要先人工确认没有遗留 Python 操作。

默认 prepare/query 成功后保留当前版本链最近 2 个索引，并额外保留待写上下文引用的索引；使用 `--retain 0` 关闭自动清理。prune 支持预览，不调用模型。清理仅移除派生 output/cache/input/prompts，保留正文数据库、共享只读正文对象、manifest、完整查询记录与清理元数据。正文对象按 bodyHash 复用，快照 input 优先硬链接；可变向量不使用硬链接。被清理的旧章索引再使用时须重新索引，可能再次产生模型费用。异常清理错误通过 maintenanceWarning 返回，已经准备好的章节仍可使用。活动工作包的未完成章节可能使保留数超过配置值。

local/global/drift/basic 是官方 GraphRAG 查询模式，语义检索和社区摘要由其完成。回答可能含推断或人物误解，输出 `advisory: true`，不写入正式事实；回到原文核对之后才能用于正文。该后端是作者视角；--holder/--hops 要显式选择 --backend local。

默认编排器把回答缓存为 queries/<receiptId>.json，缓存键包含前缀版本、索引配置、产物校验值、query 和 method。prepare 把带哈希的回答片段以 kind=retrieval 加入 context，并记录 receiptId/answerHash/configHash/outputHash。长回答按字符预算截取，完整内容留在私有检索记录；不要把检索建议当成事件证据。重复 prepare 复用回答；verify/commit 校验同一记录并重算上下文，不重新调用模型。手工 `memory graphrag query` 则可以重新生成该查询的回答，已有草稿需重新准备后提取/审阅。

GraphRAG 的 `[Data: Sources/Entities/Relationships/Reports (...)]` 引用经本地 parquet 表追溯到 text_units、documents 和 manifest，返回 sources 中的章节、revision、bodyHash 与能逐字匹配的 excerpt。准备上下文时按预算补入这些原文。无法定位的 ID 留在 unresolvedCitations，不伪造引用；最多解析 32 条引用、64 个来源。片段匹配证明来源存在，不证明模型结论成立，仍需核对全文语境。

TypeScript 集成使用 `new WriterMemory(project).prepare/query`，两者为异步接口。`Project` 保留同步正式数据与结构化图 API；默认 Microsoft 模式下 `Project.prepare` 只消费已经生成并通过校验的检索记录，避免跳过默认检索。首章和显式 local 模式仍可直接准备。

## 用量与实验

v0.7 支持 `memory graphrag setup --python EXE --credentials FILE --preset qwen-bge-m3` 简化配置：Qwen 凭据由既有 .env 读取，embedding 为本机 Ollama 的 bge-m3、1024 维。手工 embedding 参数不能与预设混用，已有配置加 --reconfigure。推荐 --credentials，避免部分 Node 版本抢先解析 --env-file。Ollama/Python 的安装仍由用户或 Codex 按环境完成。

`doctor --models` 或 `memory graphrag diagnose` 检查 Python 与模型配置，不调用模型；显式 --probe 才逐模型发送小请求并核对 embedding 维度。configured 与 ready 分开显示；探测用量单独返回，不计入 GraphRAG 作业账本。

`memory budget configure --max-requests 100 --max-tokens 500000` 配置每个 index/update/query 的非缓存调用尝试上限和本书累计观测付费 token 阈值。`--max-cost 10 --prices FILE` 可配置金额阈值；model 价格名称使用 memory usage 的完整标识，如 openai/qwen-model，currency 决定金额单位。配置命令替换全部限制。缓存不消耗新额度，本地 BGE 不计付费 token；请求次数仍包含本地 embedding。未知用量默认阻止后续 token/金额受限调用，不能把未统计费用当作零。

阈值在响应后更新，已在途请求可能超出；底层网络重试不由中间件调用尝试计数证明。`memory budget show` 查看原因，recover 仅解除已停止主/子进程的锁，clear 关闭限制。不得为了自动续写绕过作者配置的预算。金额缺少当前模型价格时在调用前停止。同书受限作业串行运行；预算配置与数值账本随 Git 检查点保存，但旧检查点之后的费用须另行核对。Codex 写作、诊断探测、本地硬件费用均不包括在此阈值内。

`memory usage [--prices FILE]` 查看升级后记录的 GraphRAG 请求用量；索引/查询/缓存复用分开记录，completion 与 embedding 分开统计。GraphRAG 本地缓存重放的历史 usage 不计新消耗；失败、缺失用量与重试保留未知，不当作零费用。该报表不包括 Codex 写作、提取和审稿。`benchmark run` 在独立实验目录进行全量、缓存、增量和结构化检索对照，默认离线；真实调用与人工评分见 [实验说明](benchmark.md)。

本版固定指标处理器为官方 default/memory，关闭官方聚合日志写入，使用版本绑定 observer 记录逐请求数值。该设置改变索引配置哈希；已有索引若提示配置过期，应按提示使用 `memory graphrag index --at N --rebuild`，可能产生模型调用。正文与正式记忆不会被修改。

## 参考与边界

- [ainovel-cli](https://github.com/voocel/ainovel-cli)：复用并扩展其章节回顾、状态、关系、时间线、伏笔与角色登场契约，保留 Apache-2.0 归属，详见 THIRD_PARTY_NOTICES.md。
- [InkOS](https://github.com/Narcooo/inkos)：参考正文证据驱动的状态投影、资源核算、认知边界和伏笔状态设计；未复制 AGPL 源码、schema 或提示词。
- [Microsoft GraphRAG CLI](https://microsoft.github.io/graphrag/cli/) 与 [3.3.0 Python 包](https://pypi.org/project/graphrag/3.3.0/)：通过进程 API 集成，作为默认后端的独立 Python 依赖安装。

新 delta/review 使用 schemaVersion 2，绑定 intentHash，要求证据 basis 与证据/遗漏/连续性审阅检查；重复引用需 UTF-16 字符偏移。新 context.reviewPolicyVersion=1 要求重要世界声明逐项审阅 critical_checks；获取当前清单使用 review-requirements。位置/location/当前位置/所在地、生死/life/alive/存活状态、境界/realm/修炼境界、真实身份/identity/真正身份归一为单值状态，不能添加不同当前值；改变需要匹配 old_value。状态字段的 alive/dead/活着/死亡值兼容归一，其他状态名不会自动猜测。

默认编排器对回答做来源与当前正式状态核对，返回 assessment。missing/partial 引用或已识别冲突时不采用回答，context 保留核对提示和正式证据；审阅在 retrieval_check 中绑定 assessmentHash 并记录核对结论。已识别冲突带正式原文、章节和 revision，覆盖常见生死/位置/境界/身份/数值资源句式。accepted=true 只说明来源可定位且没有发现这些规则能识别的冲突，不证明结论蕴含、完整性或角色知情。原始回答仍保留在私有 receipt 供追溯。

自动核对最多读取 60000 字符，assessment.checkedCharacters 和 analysisTruncated 记录范围；超限回答标为 needs-review 并排除，不能把未检查的剩余内容当成已通过。此上限不同于写作 context 的字符预算。

已接纳版本 1 继续重放，不改写历史；SQLite 数据库版本仍为 2。图计算升级为 kernelVersion 3，旧派生缓存不用于新上下文，Microsoft 快照需要重新建立。历史版本 2 若已有互相矛盾的关键当前值，会明确报错，需要作者核对后按旧章返修流程修复，不能自动猜测真值。复杂倒叙、自动人物消歧、通用语义蕴含校验和百万字性能基准仍待完善。备份、恢复和迁移见 [版本管理](versioning.md)。
