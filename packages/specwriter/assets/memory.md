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

实体 ID 使用 `lin-zhou` 这样的稳定名称（小写字母起始，允许数字、横线、下划线），同一角色改称号仍用相同 ID；别名仅从正文确立的信息登记。相同别名属于多个实体时，图保留未消歧引用，不自动合并。事实、参与者、地点和资源所有者优先使用同一稳定实体 ID；已有人名数据仍可检索。

```json
{
  "entities": [{
    "id": "lin-zhou", "name": "林舟", "type": "character",
    "aliases": ["小舟"], "description": "本章出场人物",
    "evidence": {"quote": "白衡叫了一声小舟，林舟回过头来。"}
  }],
  "narrative_events": [{
    "id": "break-seal", "description": "林舟打破封印",
    "story_time": "次日黎明", "participants": ["lin-zhou"],
    "location": "山洞", "causes": [], "scope": "world", "holder": null,
    "evidence": {"quote": "次日黎明，林舟在山洞打破封印。"}
  }],
  "resource_changes": [{
    "entity": "lin-zhou", "resource": "灵石", "opening": 10, "change": -3, "closing": 7,
    "evidence": {"quote": "林舟有十枚灵石，花掉三枚，还剩七枚。"}
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

新项目配置，以及没有 memory 字段的旧项目，默认按以下设置运行：

```yaml
memory:
  backend: microsoft-graphrag
  method: local
  autoIndex: true
```

`prepare N` 自动取回截至 N−1 章的正式原文前缀：没有完成索引时建立标准索引，已有且校验通过的索引复用；再按本章 query 取回模型回答。第一章没有历史正文，标记 empty 并跳过 Python/模型调用。不提供 query 时使用“事件、人物、状态、认知与未兑现伏笔”的续写检索目标。`memory query` 同样自动使用 Microsoft，支持 `--method global` 等模式。

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

索引完成后才写 ready.json，记录语料、配置、提示和产物校验值。query 拒绝不完整、被修改或版本不匹配的索引；操作前后核对正文版本，避免并发修订后返回过期答案。新章不会改变旧章前缀索引；旧章重写会生成新 snapshotId，默认下一次准备会索引新前缀。已生成索引不自动覆盖；确需重建同一前缀时，明确删除该快照的 ready.json 后重新 index。更改模型/提示词后旧索引会明确报错，需要重建。进程异常终止留下锁时，确认锁记录的 PID 已停止后移除锁文件。

local/global/drift/basic 是官方 GraphRAG 查询模式，语义检索和社区摘要由其完成。回答可能含推断或人物误解，输出 `advisory: true`，不写入正式事实；回到原文核对之后才能用于正文。该后端是作者视角；--holder/--hops 要显式选择 --backend local。

默认编排器把回答缓存为 queries/<receiptId>.json，缓存键包含前缀版本、索引配置、产物校验值、query 和 method。prepare 把带哈希的回答片段以 kind=retrieval 加入 context，并记录 receiptId/answerHash/configHash/outputHash。长回答按字符预算截取，完整内容留在私有检索记录；不要把检索建议当成事件证据。重复 prepare 复用回答；verify/commit 校验同一记录并重算上下文，不重新调用模型。手工 `memory graphrag query` 则可以重新生成该查询的回答，已有草稿需重新准备后提取/审阅。

TypeScript 集成使用 `new WriterMemory(project).prepare/query`，两者为异步接口。`Project` 保留同步正式数据与结构化图 API；默认 Microsoft 模式下 `Project.prepare` 只消费已经生成并通过校验的检索记录，避免跳过默认检索。首章和显式 local 模式仍可直接准备。

## 参考与边界

- [ainovel-cli](https://github.com/voocel/ainovel-cli)：复用并扩展其章节回顾、状态、关系、时间线、伏笔与角色登场契约，保留 Apache-2.0 归属，详见 THIRD_PARTY_NOTICES.md。
- [InkOS](https://github.com/Narcooo/inkos)：参考正文证据驱动的状态投影、资源核算、认知边界和伏笔状态设计；未复制 AGPL 源码、schema 或提示词。
- [Microsoft GraphRAG CLI](https://microsoft.github.io/graphrag/cli/) 与 [3.3.0 Python 包](https://pypi.org/project/graphrag/3.3.0/)：通过进程 API 集成，作为默认后端的独立 Python 依赖安装。

schemaVersion 1 保留原字段并新增可选数组，旧 delta 可以重放；SQLite 自动将数据库 schema 1 迁移到 2，新增可重建的图缓存。复杂倒叙的故事时间推理、自动人物消歧、语义蕴含校验以及百万字性能基准仍待完善。
