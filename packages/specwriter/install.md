# 交给 Codex 执行的 SpecWriter 安装指南

适用版本：SpecWriter 0.11.x。主要环境：Windows＋PowerShell。目标是把 SpecWriter 安装到本机，配置 Microsoft GraphRAG＋Qwen＋本地 BGE-M3，创建可在 Codex 中使用的独立小说目录，并安装研究、历史核查、阶段回顾与完结等13个 Skills。

## 用户怎么使用这份文件

在 Codex 中打开已下载的 SpecWriter 项目，把本文件交给 Codex，并发送：

> 请按 install.md 实际完成 SpecWriter 的安装和验证。优先复用已有环境及 .env，允许安装必要依赖、下载 BGE-M3，并进行一次小请求模型连通检查。小说放在独立目录；已有信息直接使用，缺少必需信息集中问我。安装后告诉我打开哪个目录、怎么开始写作和阅读，不要开始写正文。

如果只提供这份文档，没有源码或安装包，还需提供源码目录、源码下载地址或本地 tgz 安装包。当前项目没有发布到 npm；不要猜测仓库地址，也不要执行 `npm install -g specwriter` 来冒充安装本项目。

## Codex 的执行约定

这是安装执行说明，请实际检查、安装、配置和验证，不只列命令。用户在会话中明确的选择优先于本文默认值。

- 先检查会话已有路径、凭据文件及运行环境；能确定的信息直接使用。仅对缺少的源码来源、凭据文件、模型或目录冲突集中澄清。无需让用户选择每个内部技术参数。
- 默认使用 Microsoft GraphRAG、Qwen 和 Ollama BGE-M3。只有作者明确选择离线模式时才用 `--backend local`，不能在模型失败后静默降级并声称安装完成。
- 保留源码中的未提交改动、已有小说、API Key、模型和配置。不执行 Git reset/clean/pull、不删除环境重装，不覆盖已有 `.env`。
- 复用兼容依赖；不为了安装强制升级其他项目的 Python、Node 或 Ollama。GraphRAG 使用独立虚拟环境，不装到全局 Python。
- 凭据通过文件读取；不输出密钥、不把密钥放进命令行或报告、不上传配置。不要求用户把 API Key 粘贴到聊天中。
- 依照当前 Codex 的工具权限执行。需要管理员/UAC 操作时说明具体原因，让用户完成必要交互；其余可执行步骤继续进行。
- 小模型探测仅在已有授权时执行。上方示例提示已包含该授权；若用户选择不调用模型，则完成离线检查并如实标记“模型尚未验证”。不运行建库、长篇实验或自动写作来测试安装。
- Windows 使用 `npm.cmd`，路径按本机解析，含空格时正确引用。无需修改 PowerShell 执行策略或激活虚拟环境，直接调用其 python.exe。

## 1. 确定安装来源和目录

区分三个目录：

| 目录 | 用途 |
| --- | --- |
| SpecWriter 安装目录 | 源码、编译后的 CLI，或安装的 npm 包；保持位置稳定 |
| Python 虚拟环境 | 存放 GraphRAG 依赖，可供多本书复用 |
| 小说目录 | 存放该书 Spec、正文、批注、记忆、索引和独立 Git 历史 |

源码安装时，应同时找到根目录 `package.json`、`package-lock.json` 和 `packages/specwriter/package.json`。本文件在源码根目录和 npm 包中都有副本，不能仅凭本文件所在目录判断它一定是源码根目录。

用户未指定小说路径时，可使用用户目录下 `novels/my-book`；书名默认“未命名小说”，之后由作者确定。目标已存在时先检查：已有 SpecWriter 小说需恢复/更新，不新建第二个书籍身份；非空且不是 SpecWriter 小说的目录需换一个空目录或澄清。小说目录不要与源码目录混在一起，Windows 尽量采用短路径。

下面的 `$SwRoot`、`$SwBookRoot`、`$SwEnvFile` 是示例变量，Codex 必须替换为已确定的真实绝对路径。不能原样执行占位值，不能复用系统变量 HOME/CODEX_HOME。

## 2. 检查与准备依赖

| 依赖 | 要求 |
| --- | --- |
| Codex | 用户可以在 Codex 中打开本地小说目录，执行文件和命令 |
| Node.js | 24 或更高；优先使用本项目已验证的 Node 24 系列 |
| npm | 随兼容 Node 安装，Windows 调用 npm.cmd |
| Python | >=3.11 且 <3.14，建议 3.12；不要用 3.14 或更新版本创建此环境 |
| Microsoft GraphRAG | 本项目固定 graphrag==3.3.0；适配器支持 3.3.x |
| Ollama | 本机可运行，提供 127.0.0.1:11434 服务 |
| BGE-M3 | Ollama 中的 bge-m3，当前接入使用 1024 维密集向量 |
| Git | 本地小说版本管理需要；不需要 GitHub 账号或远端仓库 |

先运行版本检查，并核对实际可执行文件路径，不能把 Windows 的 Python 安装占位入口当作可用解释器：

```powershell
node --version
npm.cmd --version
git --version
py --list-paths
ollama --version
```

缺失某个命令并不意味着其他步骤也要停止。可从当前环境已安装的软件位置找到可执行文件。确实缺失时，使用可核实来源的包管理器或官方安装程序安装对应依赖；安装后重新定位程序并验证，避免盲目重复安装。Git 缺失时先完成其余配置，但备份验收不得标为通过。

官方来源：[Node.js](https://nodejs.org/en/download)、[Python](https://www.python.org/downloads/)、[Git](https://git-scm.com/downloads)、[Ollama Windows 安装说明](https://docs.ollama.com/windows)。虚拟环境无需激活即可用其解释器运行，见 [Python venv 文档](https://docs.python.org/3.12/library/venv.html)。

## 3. 安装 SpecWriter

### A. 已有源码（首选）

在源码根目录执行；每条命令成功后再进入下一步：

```powershell
$SwRoot = '替换为源码根目录的绝对路径'
Set-Location -LiteralPath $SwRoot
npm.cmd ci
npm.cmd run build
$SwPackageRoot = Join-Path $SwRoot 'packages/specwriter'
$SwRuntimeRoot = $SwRoot
$SwCliPath = Join-Path $SwPackageRoot 'dist/cli.js'
node "$SwCliPath" help
```

已经安装且可正常运行时可复用，不必重复下载所有依赖。使用 npm ci 时遵守当前锁文件；失败先检查 Node/npm 版本、网络、代理、锁文件和权限，不使用 --force 或自动改写项目锁文件。

不要求 npm link 或全局安装，避免 PATH 与权限问题。小说 init 后会生成本地启动器，指向本次安装的 CLI。

### B. 已有构建好的 tgz 安装包

在用户选择的专用安装目录安装，不写到小说目录：

```powershell
$SwInstallRoot = '替换为专用安装目录的绝对路径'
$SwPackageFile = '替换为本地 specwriter-0.11.x.tgz 的绝对路径'
npm.cmd install --prefix "$SwInstallRoot" "$SwPackageFile"
$SwPackageRoot = Join-Path $SwInstallRoot 'node_modules/specwriter'
$SwRuntimeRoot = $SwInstallRoot
$SwCliPath = Join-Path $SwPackageRoot 'dist/cli.js'
node "$SwCliPath" help
```

安装包须含 dist、assets、schemas 和 requirements-graphrag.txt；用户安装 tgz 无需再编译。维护者在源码根目录先 build，再运行 `npm.cmd pack --workspace specwriter` 才生成可分发包。缺少 dist 的包不能作为安装成功处理。

## 4. 准备独立 GraphRAG 环境

先尝试复用当前安装目录下 `.graphrag-venv` 或用户明确指定的兼容环境。验证 Python 版本和 GraphRAG 版本；如果已有环境不兼容，保留它，另选新环境路径。

以下仅适用于尚未创建目标虚拟环境、且本机已确认有 Python 3.12 的情况：

```powershell
$SwVenvRoot = Join-Path $SwRuntimeRoot '.graphrag-venv'
py -3.12 -m venv "$SwVenvRoot"
$SwPythonExe = Join-Path $SwVenvRoot 'Scripts/python.exe'
& "$SwPythonExe" -m pip install -r (Join-Path $SwPackageRoot 'requirements-graphrag.txt')
& "$SwPythonExe" --version
& "$SwPythonExe" -m pip show graphrag
```

若没有 py 启动器，使用已验证的 Python 解释器绝对路径执行 `-m venv`。Linux/macOS 对应 Python 路径为虚拟环境的 `bin/python`，npm 不带 .cmd；按实际系统调整，不能把 Windows 命令直接复制过去。

## 5. 准备本地 BGE-M3

先检查本机 Ollama API 和模型，已有 bge-m3 不重复下载：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10
ollama list
```

API 未运行时，先检查已安装 Ollama 应用；只有确认没有已有服务占用时才启动服务。需要由 Codex 启动后台服务时使用隐藏窗口，并保留进程信息：

```powershell
Start-Process -FilePath (Get-Command ollama).Source -ArgumentList 'serve' -WindowStyle Hidden
```

确认模型缺失且已获下载授权后：

```powershell
ollama pull bge-m3
```

下载期间报告进度，失败后保留已有模型，不卸载服务或清空模型目录。模型名称和下载命令见 [Ollama BGE-M3](https://ollama.com/library/bge-m3)，服务命令见 [Ollama CLI](https://docs.ollama.com/cli)。当前预设使用 127.0.0.1:11434/v1；端口不同需采用手工 embedding 参数，而不是强行修改别的服务。

## 6. 取得 Qwen 配置

优先使用用户已明确授权的 `.env` 路径，其次检查源码根目录是否已有 `.env`。不要遍历其他项目寻找密钥。只报告缺少哪些字段，不回显文件或解析结果里的密钥。

支持两种格式：

1. `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL` 三个变量。
2. 已有 `LLM_PROVIDERS` JSON，选取 qwen 的 `api_key`、`api_url`、`models`，protocol 必须是 openai_chat_completions。

如需新配置，把本项目 `.env.example` 复制到用户选定的私有配置位置，让用户在本地填入真实凭据；目标存在则保留。不要把例子中的占位值当作可用配置。`QWEN_BASE_URL` 使用该账号实际服务区域的 OpenAI 兼容 API 地址，不替用户猜测区域、模型权限或价格。

已有多个模型且不能从 QWEN_MODEL/会话偏好确定时，集中询问一次，然后在 setup 中传 --model。缺少 API Key 时先完成不依赖它的安装步骤；明确列出待用户本地填写项。不能因为第一章不检索就声称整个记忆系统已经可用。

## 7. 新建或更新小说目录并接入模型

新建空小说目录：

```powershell
$SwBookRoot = '替换为独立小说目录的绝对路径'
$SwBookName = '未命名小说'
node "$SwCliPath" init "$SwBookRoot" --name "$SwBookName" --json
```

既有 SpecWriter 小说只在需要更新启动器或 Skills 时重新 init，先检查其 status；不要覆盖作者修改的 Skills 或 Spec。init 返回 preserved 时报告被保留的文件，不把它们当作安装失败后直接替换。

v0.11 init 递归安装 Skills 自带参考文件及共用 research/lifecycle 协议；已有作者自定义 Skill 保留，受保护的旧入口可能需要作者根据新版说明手动合并。检查完整的13个入口和相关 references，而非只复制 SKILL.md。研究与历史核查按书隔离，升级不自动采用报告、改约定、把外部资料加入 GraphRAG或宣布作品完结。

确认小说 `.specwriter/bin/specwriter.mjs` 存在后，切换到小说目录配置：

```powershell
$SwEnvFile = '替换为已配置凭据文件的绝对路径'
Set-Location -LiteralPath $SwBookRoot
node .specwriter/bin/specwriter.mjs memory graphrag setup --python "$SwPythonExe" --credentials "$SwEnvFile" --provider qwen --preset qwen-bge-m3 --json
```

有需要时加 `--model 实际模型名`。用 --credentials，避免部分 Node 版本先行解释 --env-file。不要把 --preset 与 --embedding/--embedding-base/--embedding-dimensions 混用。

已有 `.specwriter/graphrag/provider/settings.yaml` 时先诊断、尽量复用；只有本次用户要求应用不同配置时使用 --reconfigure。配置改变会使既有索引失效，安装任务不擅自重建整本书。

新小说默认启用独立 Git 版本管理：

```powershell
node .specwriter/bin/specwriter.mjs version init --json
```

已有小说不改变其关闭自动备份的选择；需要更新时按既有授权补存检查点。该版本库不会操作作者已有 Git 暂存区或推送远端。

预算不是安装必需参数。作者已给出额度时按其选择配置 memory budget；否则报告未设置，不编造金额、模型价格或偷偷使用 unknown-usage allow。

## 8. 安装验收

先做不调用模型的检查：

```powershell
node .specwriter/bin/specwriter.mjs status --json
node .specwriter/bin/specwriter.mjs doctor --models --json
node .specwriter/bin/specwriter.mjs version status --json
```

检查 doctor.healthy=true、models.runtime.ready=true、models.configured=true，且 init 生成的13个 `.agents/skills/specwriter*/SKILL.md`（总入口＋12个专项）、各 Skill 的相关 references 和本地启动器完整。本版新增入口为 specwriter-recap、specwriter-finish，lifecycle.md应可从各相关Skill读取。新版 status.backup 应可读取检查点；若作者文档在初始化后又改动，needsSave=true 是待保存，不伪报为 Git 故障。

不调用模型的题材方法检查可以运行 `node .specwriter/bin/specwriter.mjs craft list --json`，应返回五类原创方法。联网调研使用 Codex 当前可用的搜索/浏览工具，不需要配置额外搜索 Key；CLI radar 只抓公开榜单快照，不是 Qwen 搜索能力。没有联网工具、网络或公开页面访问失败时报告来源不足，不影响已完成的本地方法安装，也不能声称市场数据已验证。安装阶段无需创建市场报告、采用空模板或主动抓榜单。

生命周期安装检查只读 `memory check list --json` 与 `finish status --json`。新书空任务列表、status=unfinished 是正常状态；不要为验收创建核查报告、接纳空正文或填写假的完结理由。空历史不会调用 GraphRAG；已有书新的计划/影响/回顾/完结准备可能查询模型，当前章 review 默认复用有效 context、显式新问题才检索。这些属于作者创作任务，安装阶段不执行。

已有小请求探测授权时执行一次：

```powershell
node .specwriter/bin/specwriter.mjs doctor --models --probe --json
```

models.ready=true 才说明当前生成与 embedding 模型响应通过检查。探测会产生少量生成模型用量，单独返回 observedUsage；不要把它算成全书费用或百万字记忆质量验证。不通过时根据 HTTP 状态、网络、模型名、Ollama 服务和向量维度修复，避免无上限重复探测。

运行阅读器检查空书或已有章节页面：

```powershell
node .specwriter/bin/specwriter.mjs read --no-open
```

服务持续运行，应使用可保留的终端/后台进程读取实际返回 URL；不要阻塞安装流程等待它自行退出。通过 HTTP/浏览器检查返回的本地 URL，再按作者需求保留或正常停止服务。端口取实际返回值，不硬编码端口；不要暴露到外网。没有章节时显示空目录是正常结果，不伪造正文来演示。

最后用简短中文报告：

- SpecWriter、Python 虚拟环境和小说目录的实际路径。
- 软件安装、配置检查、模型探测、Git 备份、阅读器各项通过/未验证/失败状态。
- 尚缺的必需信息或操作，以及已经保存的成果；有失败就不能笼统声称“全部可用”。
- 明确说明没有写正文、没有执行全书 GraphRAG 建库或长篇实验。

环境检查通过仍不等于已验证真实连续创作质量或百万字召回。

## 9. 把创作交还给作者

让用户在 Codex 中打开**小说目录**。如当前会话尚未发现新 Skills，重新打开该目录或新建该目录中的会话；不要声称已在安装源码目录的会话加载小说 Skills。

作者可以直接说：

> 帮我构思一本修仙悬疑小说，先整理设定和开篇计划，不写正文。

> 按已确认的设定写第一章，先给我审阅草稿。

> 按我授权的范围连续写三章，每章完成审阅后接纳，我随时会提出修改意见。

推荐 `$specwriter` 总入口，Codex 按作者意图自动路由研究、拆书、题材方法、构思、写作、阶段回顾与完结。需要时先“调研 → 拆书/题材方法 → 作者选定 → Specs 采用 → 章纲 references → 写章/审阅 → 阶段回顾/完结检查”；普通构思无需强制调研。新书 resume 显示未开始/缺少约定或工作包是正常状态，安装阶段不采用空模板或伪造写作授权。专项入口为 `$specwriter-research`、`$specwriter-analyze`、`$specwriter-craft`、`$specwriter-explore`、`$specwriter-propose`、`$specwriter-write`、`$specwriter-review`、`$specwriter-revise`、`$specwriter-commit`、`$specwriter-recap`、`$specwriter-finish`、`$specwriter-archive`，作者通常无需分别调用。

计划、独立审阅、修订、回顾与完结须读原文并保存实际核查，不把 prepared 当完成。独立正式正文审阅不需要创建修订包；impact 后文与目标章写作上下文分开。finish save 是检查报告，只有真实作者当前版本完结指令才 accept；新章或相关输入变化后旧证明失效，追加新章扩大范围时使用新 finish ID。升级不会从旧归档或导出文件推断整本小说已完结。

阅读时在小说目录运行 `node .specwriter/bin/specwriter.mjs read`；保存批注后将带小说身份的“复制给 Codex”请求粘贴到本书对话，或让 Codex 读取反馈。采纳意见进入目标章资料包/审阅，正式接纳后绑定落实版本；“先处理再继续”在后续 CLI 检查阻止推进，不自动发消息或中断正在生成的内容。正式导出使用 `export --format txt`、`md` 或 `html`。首次创作由 Codex 阅读生成的 AGENTS.md、Skills 和协议执行，不要求作者手工填写提取或审阅 JSON。

安装目录后续移动或升级，需用新的 CLI 对各小说重新 init 更新启动器；模型参数改变按既有小说的提示处理。不同小说的正文/记忆/索引隔离，Python、Ollama 和 BGE 模型可以共用。

## 常见阻塞的处理

| 情况 | Codex 应执行的处理 |
| --- | --- |
| 没有源码或 tgz | 询问来源；不猜仓库或下载同名 npm 包 |
| Node 版本过低或无 node:sqlite | 使用兼容 Node，再 build/验证 CLI |
| Python 版本不兼容 | 新建兼容环境，保留其他项目环境 |
| npm/pip/模型下载失败 | 检查网络、代理、磁盘和权限，保留已完成步骤 |
| `.env` 缺字段或模型不唯一 | 集中列出缺项，用户本地补配置，不打印密钥 |
| Ollama 不通或没有 bge-m3 | 检查已有服务、实际端口和模型，再启动/下载 |
| Qwen HTTP 401/403 或模型无权限 | 核对凭据、API 地址和模型；不切换成别的收费模型 |
| BGE 维度不匹配 | 核对模型与 1024 维设置，不能伪造向量或共享别书索引 |
| Git 保存失败 | 章节与备份分别报告；修复后 version save，不重复 commit |
| Windows 路径过长 | 新书选择短目录；已有书另行按迁移流程处理，不直接搬动/删除 |
| 已有小说正文直接改动 | 保留改动；按 sync --capture/修订流程处理，不覆盖后重装 |

不要删除当前数据库、锁或索引来让验收“变绿”。安装只处理依赖与配置；存量小说修复、搬迁、索引重建需要按其实际业务范围执行。
