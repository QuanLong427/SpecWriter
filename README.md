# SpecWriter

面向 Codex 的长篇小说创作工作流。作者提供想法、授权和阅读意见，Codex 通过 Skills 规划、写作与修订，WriterMemory 保存有正文证据、可追溯且带章节边界的长期记忆。

**v0.8 已接通逐章创作闭环：设定与计划 → 章纲与记忆 → 草稿 → 提取与审阅 → 按授权接纳 → 阅读、批注和修订 → 下一章。** 自动卷回顾、完结检查及真实长篇质量验证仍在后续计划中。96 项回归测试与三章短篇流程演练的范围见 [验证报告](docs/v0.8-workflow-validation.md)。

## 作者怎么使用

作者通常只需要 `$specwriter` 总入口和自然语言。内部的章纲 JSON、事实提取、审阅记录和 CLI 命令由 Codex 操作。下面用一部河镇悬疑小说演示完整的开篇流程。

### 1. 安装并打开小说目录

下载源码或取得本项目安装包后，把 [install.md](install.md) 交给 Codex，发送：

```text
请按 install.md 实际安装和验证 SpecWriter。复用已有环境及凭据文件，
小说目录使用 E:\novels\my-book。允许准备必要依赖，并进行一次小请求模型连通检查。
安装后告诉我打开哪个目录、怎么开始写作和阅读，先不要写正文。
```

安装指南包含 Microsoft GraphRAG、Qwen、本地 Ollama BGE-M3 和 Git 备份配置。本项目尚未发布到 npm，源码或 tgz 的安装方式以指南为准。模型连通探测可能产生少量费用。

安装后在 Codex 中打开 **`E:\novels\my-book` 小说目录**。Skills 位于该书的 `.agents/skills/`；已有会话若未发现新 Skills，重新打开目录或开启该目录的新会话。

### 2. 先构思和规划，不写正文

```text
$specwriter 帮我构思一部长篇河镇悬疑小说。
主角阿宁带着母亲留下的旧灯去寻找失踪的姐姐，使用第三人称限知视角。
先整理故事主线、世界规则、人物和文风，再规划开篇三章。
给我看方案，暂时不要写正文。
```

Codex 用 explore/propose 整理四份创作约定和近期计划。作者先选定方案，Codex 再采用约定版本、建立有章节范围的工作包。全书大纲是方向，近期场景可以细化；未来计划不会作为已发生事实进入记忆。

### 3. 采用方案，先看第一章草稿

```text
$specwriter 采用当前方案。把开篇三章作为一个工作包，
本次只写第一章草稿，目标约 3000 字，先不要接纳为正式正文。
完成章纲、取回必要记忆、写作、事实提取和审阅，再打开草稿阅读器。
```

Codex 记录第 1 章的 draft 授权，完成结构化章纲并准备上下文，再写草稿、提取事实和审阅。首章没有历史正文，跳过模型记忆检索；后续章节默认索引和检索已接纳前缀。Qwen 用于 GraphRAG 索引与查询，正文仍由 Codex 创作。

**第一章尚未接纳时，不能继续准备第二章。** 后续章节依赖前一章的正式记忆。因此“先看草稿”按章进行；若要连续写三章，应明确授权逐章审阅通过后接纳。

### 4. 阅读、批注并修改草稿

阅读器支持章节切换、字号/行距、夜间模式、阅读进度、版本对照和段落批注。阅读与批注不调用模型。写作完成后刷新正文即可看到最新版本。

在阅读器保存意见，按“复制给 Codex”粘贴到小说对话，或直接发送：

```text
$specwriter 按我在阅读器中对第一章的批注修订草稿。
保留渡口冲突，但不要让阿宁提前知道灯柄缺口的用途。
重新提取事实并审阅，先把修改后的草稿给我看，不接纳。
```

批注不会自动改正文。Codex 根据对话中的修订要求核对批注版本、修改正文并重新提取审阅；作者确认后再接纳。

### 5. 接纳第一章，授权连续写后两章

```text
$specwriter 接纳修改后的第一章。
继续写第 2 至第 3 章，允许每章完成提取、审阅和 verify 后自动接纳。
遇到阻塞矛盾时先停下处理，不越过第 3 章；我随时会提出修改意见。
```

Codex 按实际授权逐章执行下方循环，到第 3 章边界停止。已给出的授权无需每章重复确认；需要作者判断的问题、暂停或用量限制仍会停止推进。

```mermaid
flowchart LR
    A[章纲与必要记忆] --> B[Codex 写草稿]
    B --> C[事实提取与审阅]
    C --> D[按授权接纳]
    D --> E[更新正式记忆]
    E --> A
    B --> F[作者阅读与批注]
    D --> F
    F -->|作者要求修订| B
```

### 6. 暂停或换会话后继续

```text
$specwriter 暂停当前工作包，我先审阅已有章节。
```

暂停会保存到本书，阅读和审阅仍可用。新会话中可以先恢复状态：

```text
$specwriter 从当前小说目录恢复进度，告诉我已接纳到哪章、
当前停在哪一步、有没有待审阅草稿或过期后文，先不要继续写。
```

作者明确要求恢复后，Codex 才解除暂停，在已有或新授权的范围内继续。`resume` 读取本地文件和记录，不依赖旧聊天，也不调用模型。

修订已经接纳的旧章时，Codex 创建修订工作包。旧章重新接纳后，后续记忆标记为需重审，按授权顺序核对；不能直接把过期后文作为最新小说导出。

### 7. 回顾这一段、导出作品并备份

```text
$specwriter 回顾开篇三章的计划执行情况与遗留线索，归档已完成的工作包。
导出当前连续有效的正式正文为 TXT、Markdown 和 HTML，并保存 Git 检查点。
再给我第 4 至第 6 章的计划，先不写新章。
```

当前回顾由 Codex 在工作文档中记录，尚没有独立的自动卷回顾或完结检查。归档只关闭该工作包，不代表整本小说完结。导出位于小说目录 `exports/novel.{txt,md,html}`，只包含连续有效的正式章节；HTML 关闭阅读服务后仍可打开。

启用 `version init` 后，每次接纳自动保存本书独立的 Git 检查点。单独改动设定、批注或归档工作包后再 `version save`；异地备份可导出 bundle。恢复到新目录，模型配置和索引需重新配置/构建，步骤见 [版本与备份](packages/specwriter/assets/versioning.md)。

## 小说目录里有什么

| 位置 | 作者看到的内容 |
| --- | --- |
| `specwriter/specs/` | 故事前提、世界、人物、文风；采用版本另存于本书记忆库 |
| `specwriter/plans/` | 全书方向和近期计划 |
| `specwriter/work/<id>/` | 本轮意图、章节章纲、上下文、提取与审阅记录 |
| `manuscript/drafts/` | 可审阅草稿 |
| `manuscript/chapters/` | 已接纳正文的文件投影 |
| `specwriter/feedback/` | 阅读批注 |
| `specwriter/memory/views/` | 可阅读的人物、状态、认知、事件、资源和伏笔记录 |
| `exports/` | 可交付的 TXT、Markdown 和 HTML |
| `.specwriter/` | 本书正式记忆库、GraphRAG 数据、启动器和独立 Git 检查点 |

每本小说的正文、记忆、索引、授权和批注独立；Python 环境、Ollama 和 BGE-M3 模型可共用。阅读器负责阅读与批注，正文修改由 Codex 完成。

## 想自己运行命令时

在小说目录运行。`opening` 是示例工作包 ID，请以 `status` 输出的实际 ID 为准：

```powershell
Set-Location -LiteralPath 'E:\novels\my-book'
node .specwriter/bin/specwriter.mjs resume --json
node .specwriter/bin/specwriter.mjs status --json
node .specwriter/bin/specwriter.mjs read
```

需要草稿预览、导出或检查点时按需运行，不必把整段一次执行：

```powershell
node .specwriter/bin/specwriter.mjs read --draft --work opening
node .specwriter/bin/specwriter.mjs export --format html
node .specwriter/bin/specwriter.mjs version status
node .specwriter/bin/specwriter.mjs version save --message "开篇三章已归档"
```

`read` 会持续运行本地服务，打印地址并打开浏览器，Ctrl+C 停止。在其他终端执行后续命令。完整命令见 [CLI 文档](packages/specwriter/README.md)，不要仅靠 CLI 命令期待自动生成正文。

总入口 `$specwriter` 协调七个专项 Skills：explore（构思）、propose（规划）、write（写章）、review（审阅）、revise（修订）、commit（接纳）、archive（归档）。实际名字是 `$specwriter-explore` 等，使用说明见 [创作流程](packages/specwriter/assets/workflow.md)。

## 开发者快速体验

源码开发要求 Node.js 24+。在源码根目录安装和构建；小说放到独立目录。Windows 使用 npm.cmd：

```powershell
npm.cmd ci
npm.cmd run build
node packages/specwriter/dist/cli.js init E:\novels\my-book --name "我的小说"
```

默认记忆后端是 Microsoft GraphRAG，需按 [安装指南](install.md) 配置 Python、Qwen 和本地 BGE-M3。只有显式选择离线体验时才在 init 加 `--backend local`；local 仍可练习结构化流程，但不做模型语义检索；这不表示 Codex 创作本身离线。

也可以重放随源码提供的三章原创短篇流程演练，目标必须是一个不存在的新目录：

```powershell
node packages/specwriter/examples/author-journey.mjs E:\experiments\specwriter-journey-01
```

该演练会创建独立书籍、写入固定的示例正文和逐章审阅、验证暂停后恢复、接纳和三种格式导出。它使用显式 local 模式，不调用 Qwen，不自动创作新小说，不是文学盲评或长篇召回评测。已有目录会拒绝覆盖。旧 `demo` / `demo:long` 是旧流程夹具，新工作流优先看此演练。

开发检查：

```powershell
npm.cmd test
npm.cmd run check
```

## 当前范围与后续工作

当前有 8 个 Codex Skills、结构化创作约定与章纲、带证据的正文/记忆提交、默认 Microsoft GraphRAG、阅读批注、导出及独立 Git 备份。连续写作由 Codex 在授权范围内执行，没有独立无人值守写作服务。

尚未完成自动卷回顾、整书完结检查、已有小说整本导入；3–6 万字、远距离依赖和百万字验证也未完成。规则校验和引用可定位不能证明语义判断或文学质量正确。后续按 [优化方案](docs/long-form-optimization-plan.md) 推进。

- [安装与配置](install.md)
- [完整创作协议](packages/specwriter/assets/workflow.md)
- [记忆记录与 GraphRAG](packages/specwriter/assets/memory.md)
- [阅读、批注与导出](packages/specwriter/assets/reader.md)
- [实验与质量评估](packages/specwriter/assets/benchmark.md)
- [架构与数据边界](docs/specwriter-architecture.md)
- [v0.8 验证范围](docs/v0.8-workflow-validation.md)
- [复用代码与许可证](packages/specwriter/THIRD_PARTY_NOTICES.md)

## 源码目录

```text
SpecWriter/
├── packages/specwriter/
│   ├── src/          # CLI、WriterMemory、GraphRAG 与阅读服务
│   ├── assets/       # Skills、协议、模板与阅读器
│   ├── schemas/      # 章纲、提取与审阅契约
│   ├── examples/     # 工作流演练及兼容检查
│   ├── test/         # 回归测试
│   └── licenses/     # 复用许可证
├── docs/             # 架构、优化方案与验证记录
├── install.md
├── package.json
└── package-lock.json
```

运行依赖、编译产物和本地实验不纳入 Git；小说数据由 init 在独立小说目录创建。
