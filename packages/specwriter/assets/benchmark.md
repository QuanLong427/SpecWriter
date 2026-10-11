# WriterMemory 实验与用量评估

## 最快开始

在 SpecWriter 源码目录运行：

```powershell
npm.cmd run benchmark
```

安装版可运行 `specwriter benchmark run`，小说目录可运行 `node .specwriter/bin/specwriter.mjs benchmark run`。默认离线，不需要 API Key，输出临时实验目录、report.md、report.json、ratings-template.json。`--out 新目录` 指定输出位置，现有目录会拒绝使用。整个实验目录通过 `.gitignore` 排除。

内置五章、十二个问题，四组共 48 个样例。六个检查点覆盖首次建库、追加、重复查询、伏笔兑现、旧章返修、后续协调；问题涵盖别名、资源、状态、认知、无答案和跨章证据。它是小型人工夹具，远小于三万字，不代表文学质量或百万字性能。

离线 GraphRAG 产物和回答是编排占位，回答从结构化查询构造，不读取标准答案。不生成虚构 tokens 或节省比例；离线结果不能评分为模型质量。

## 对照组

| 组 | 新前缀的处理 | 目的 |
|---|---|---|
| cold | 标准全量索引，不继承前缀缓存 | 全量重建基线 |
| warm | 标准全量索引，只继承有效较早前缀缓存 | 缓存的独立收益 |
| incremental | 标准增量更新，继承输出与缓存 | 当前优化的综合收益 |
| structural | 本地正式状态与图查询 | 结构化记忆覆盖能力 |

同一前缀的重复操作，前三组都复用完成的索引和应用查询缓存。首次没有父快照时均为标准索引。使用相同问题、模式、配置和上下文字符预算。`--budget` 控制提供给下游/评分的字符数，不限制建库 token 消耗，也不是模型 tokenizer 的精确 token 数。

工具先在独立 preflight 小说中接纳全部章节和返修，验证 schema、状态前置条件与标准引用，再开始付费调用。每组的 SQLite、正文、缓存与索引独立。实验保留全部快照，绕过生产自动清理，因此测得的存储量不能当作生产默认保留两个索引的占用。logicalBytes 是逻辑文件大小，硬链接重复计数；未测物理磁盘峰值或内存。

## 真实模型实验

先在小说项目完成 GraphRAG 3.3.x setup 和模型凭据配置，再运行：

```powershell
node packages/specwriter/dist/cli.js benchmark run --mode live --provider "E:/novels/provider-book" --max-operations 60 --out "E:/experiments/writermemory-run-01"
```

`--provider` 是小说根目录。工具只读取并复制其 provider 配置、提示词和凭据到私有实验目录，不修改源小说或索引。不要分享整个实验目录；报告虽不含凭据，但包含小说正文与回答。真实实验会调用配置的模型，产生实际费用；失败不会自动改成离线。

内置四组通常调度 48 次 index/update/query 操作。`--max-operations` 是跨所有组的操作上限，一次操作内部可请求模型多次，不能当金额或 token 上限。Ctrl+C 等待子进程退出，保存部分报告和不完整用量。`status=complete` 表示编排完成，不表示质量通过。当前失败后需使用新目录重跑，不提供断点续跑。

可用 `--arms cold,incremental` 减少调用，`--method local|global|drift|basic` 固定查询方式，`--budget 6000` 固定上下文预算。先跑小夹具，再换 3～6 万字、10～20 章样本，最后扩到 10 万、30 万和百万字。

## 自定义样本

`--dataset FILE` 使用与 `assets/benchmark/fixture.json` 一致的 JSON：

- chapters：连续 chapter、body、人工核对的部分 delta；工具产生 schemaVersion、chapter、baseRevision 和各类 Hash，禁止覆盖。
- steps：唯一 id、through 截止章号、questions；可加 retcon 修订已接纳章节，再顺序协调后续 stale 章节。
- questions：唯一 id、query、category、expectedAnswer、evidence 的 chapter/精确 quote；无答案题加 unanswerable=true。

delta 遵守正式接纳协议。自动填写的 review 仅代表人工夹具核对，不能当 Codex 语义审稿。工具验证引用出现在有效正文中，不能证明 expectedAnswer 正确。标准答案、评分字段不会发送给 GraphRAG。

固定模型、提示词、切块、语料、问题与查询模式，只改变一个优化。小样本建议重复三轮，保留随机性差异。report.json 记录 Node/GraphRAG 版本、语料/配置指纹、预算、耗时、完整回答与上下文。当前工具不自动判断成本收益显著性。

## 用量与费用

正常小说的 prepare/query/index 同样自动采集：

```powershell
node .specwriter/bin/specwriter.mjs memory usage
node .specwriter/bin/specwriter.mjs memory usage --prices "E:/experiments/prices.json"
```

记录位于 `.specwriter/graphrag/usage/`，不随索引清理删除。旧版本执行过但未记录的调用不补推。统计仅包含 GraphRAG，排除 Codex 创作、提取与审稿。

GraphRAG 本地缓存重放历史 usage，直接累加聚合值会高估新消耗。版本绑定的 Python observer 在请求指标汇入存储时采集数值，按 cached_responses 排除历史 tokens，并区分 completion/embedding。只记录模型标识和数值，不记录提示词、回答或密钥。应用层复用索引/回答记零新增请求。供应商服务端提示缓存仍是实际请求，其折扣不等于本地缓存。

coverage 是 complete/partial/unavailable/not-called。缺失 usage、失败或取消时，费用保持 null，observedTokens 只是已观测部分。observer 正常初始化并结束且没有请求时，可记录已观测零请求。原生重试可能隐藏失败尝试收费，不能把报告当供应商账单。
检测到重试时也标 partial；强制结束 Node 后留下 running/unknown 操作，避免遗漏整次调用。记录范围从升级后开始，不代表此前小说项目的累计账单。

价格由用户填写，不联网更新、不硬编码。以下仅演示格式，不是真实报价：

```json
{
  "currency": "TEST",
  "models": [
    {"model": "provider/completion-model", "kind": "completion", "inputPerMillion": 1, "outputPerMillion": 2},
    {"model": "provider/embedding-model", "kind": "embedding", "inputPerMillion": 0.1}
  ]
}
```

model 匹配 usage 报告中的标识。缺少价格或用量不全不计算总费用；服务端缓存折扣、批量价、阶梯价等需账单核对。

## 人工评分

每题记录 answer、固定预算 context、标准答案、证据覆盖率、无效来源和未解析引用。覆盖率仅检查所需原文是否进入 context；无效来源核对章节、revision、bodyHash 和片段。两者都不能证明语义正确或检测所有泄漏。完整 answer 和截取后的 context 需分别看待。

复制 ratings-template.json，填 correct、unsupported、futureLeak、staleLeak、knowledgeLeak 布尔值和非空 notes。全部 null 表示未评分，不会算通过。模型组评分答案正确性；structural 没有模型答案，correct 表示上下文是否足够支持正确回答，不能直接当模型回答正确率。

```powershell
node packages/specwriter/dist/cli.js benchmark score --run "E:/experiments/writermemory-run-01" --ratings "E:/experiments/ratings-01.json" --prices "E:/experiments/prices.json"
```

绑定 runId/caseId/answerHash/contextHash，拒绝重复或过期评分。输出 quality.json，未全部评分时 complete=false。建议人工移除组名盲评并保留映射；目前没有自动盲化或自动模型评委。

把未来/失效事实污染、认知错误作为阻断问题，再比较相同质量下累计费用、首次建库、新增章节和返修耗时。续写盲评、自动 token/金额熔断、按批次更新、物理磁盘峰值和百万字压力测试仍待实现。
