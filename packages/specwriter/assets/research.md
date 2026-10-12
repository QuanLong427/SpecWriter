# 创作研究、拆书与题材方法

研究库帮助作者选择写法，不替作者决定小说方向。市场资料、外部作品分析和方法报告不是本书已发生事实，也不会自动采用 Specs 或修改正式记忆。只有本书已接纳正文进入默认 GraphRAG 语料。

研究报告与来源绑定本书稳定 bookId。旧书缺少该身份时，原有核心写作流程仍可读取空研究库，但研究创建/捕获/保存明确拒绝；不要使用 null、别书身份或从聊天猜造身份来绕过，先按明确的身份迁移方案处理。

## 选择能力

作者通常只说 `$specwriter`，总入口根据意图路由：

| 请求 | 使用能力 | 交付 |
| --- | --- | --- |
| 查近期题材、榜单、平台或读者定位 | specwriter-research | 有日期与来源的市场报告、备选方向和未证实问题 |
| 分析作者提供或可访问的作品材料 | specwriter-analyze | 已读范围明确的机制分析和可迁移原则 |
| 学习或定制题材写法 | specwriter-craft | 原创方法参考、与本书的适配建议 |

普通构思无需先跑市场调研；已有采用约定时先读取，研究结果仅作为新选项。收到混合请求时先完成必要研究与分析，再由作者选择进入 propose。保存报告不代表作者采用。

## 联网与证据范围

Codex 运行环境有联网搜索/浏览工具时，用这些工具查当前信息并打开支持结论的页面。优先平台公开页面和其他直接来源，记录访问时间、发布日期或榜单时间窗、平台、榜单名称及实际可见范围。榜单位置、作品简介、读者评论和自己的推断应分别表述；一份榜单不能证明市场全貌、收益或某种写法必然有效。

没有联网工具或页面无法访问时，说明“当前来源不足”，可继续分析作者提供的链接内容、摘录或文件，并标记日期和范围。链接本身不等于已读内容；无法读取的页面不能充当证据。不能凭训练记忆伪造最新榜单、排名、点击量或销量。

`research radar` 是 CLI 的公开榜单快照抓取器，支持番茄和起点；不需要额外搜索 API Key，不是通用搜索引擎，也不调用 Qwen 搜索。Qwen 配置只用于本书 GraphRAG 等已有模型任务，不能据此声称拥有联网调研能力。登录限制、页面改版、反爬或网络失败时保留已完成资料并报告缺口，不伪造返回值。

## 保存资料与报告

在小说目录运行，以下命令省略通用 `--json`；ID 使用本次项目中真实且唯一的值：

```powershell
node .specwriter/bin/specwriter.mjs research create market-opening --kind market --title "开篇题材调研" --question "有哪些值得本书验证的读者承诺？" --platform "番茄与起点" --audience "待作者确定" --window "本次公开页面可见范围"
node .specwriter/bin/specwriter.mjs research capture market-opening --source ranking-01 --file PATH_TO_CAPTURE --title "实际榜单名称" --kind ranking --url ACTUAL_PUBLIC_URL
node .specwriter/bin/specwriter.mjs research show market-opening --draft
node .specwriter/bin/specwriter.mjs research save market-opening
node .specwriter/bin/specwriter.mjs research show market-opening
node .specwriter/bin/specwriter.mjs research list
```

create 返回绝对 draft.json 路径；编辑这个实际路径，再 save 校验并保存不可变报告版本。capture 从已获取的本地文本文件保存来源，web/ranking 来源保留真实 URL，日期可用 `--published-at`；file 用于可访问作品或资料，author 用于作者提供的说明。来源保存在 `specwriter/research/<id>/sources/<sourceId>.json`，正式报告位于 `versions/<sha256>.json`，current.json 指向当前已保存版本。不要手工改已捕获来源或版本文件；修订通过 draft/save 和新的来源完成。

直接抓取公开榜单可用：

```powershell
node .specwriter/bin/specwriter.mjs research radar market-opening --platform fanqie --limit 10
node .specwriter/bin/specwriter.mjs research radar market-opening --platform qidian --limit 10
```

radar 返回实际抓取结果后，读取来源内容再撰写报告；抓取成功不代表解读正确。它只记录可访问页面的快照，不自动生成可靠市场结论或采用小说方向。status 可为 ready/partial/unavailable；partial 不是完整榜单，ready 只表示本次请求样本完成。番茄采集热门和黑马分组，起点采集公开 rank 页面；平台原分类与归一分类、可能混合的作品类型见来源 metadata。默认每组最多 15 条，--limit 是每组 1–50 条；--timeout 是每请求含正文的毫秒数，范围 1–30000，默认 10000。实际返回范围与失败原因以 CLI 输出为准。

draft 报告基础字段如下；遵守 CLI 创建的模板，不自行替换 schema：

```json
{
  "schemaVersion": 1,
  "id": "market-opening",
  "bookId": "使用create生成的本书身份",
  "kind": "market",
  "title": "开篇题材调研",
  "question": "有哪些值得本书验证的读者承诺？",
  "platform": null,
  "audience": null,
  "timeWindow": null,
  "observations": [
    { "text": "可由材料直接核对的观察", "evidence": [{ "sourceId": "ranking-01", "quote": "已捕获来源中的连续原文" }] }
  ],
  "interpretations": [
    { "text": "由观察形成的有限推断，不写成确定市场事实", "sourceIds": ["ranking-01"] }
  ],
  "directions": [
    { "title": "供作者比较的方向", "premise": "可原创发展的故事前提", "reason": "为什么值得本书考虑，以及适配限制", "sourceIds": ["ranking-01"] }
  ],
  "unknowns": ["尚未读取、无法确认或需要作者决定的内容"]
}
```

引用只写必要短句。save 核对 quote 是否真实存在于所捕获原文及其哈希，不证明引用支持结论、页面内容真实、资料有代表性或文学判断正确；这些需要 Codex 和作者审阅。market/analysis 至少引用一份 web/ranking/file 来源并提供精确引文，craft 也需要来源和引文，可使用 author 或由 craft use 捕获的 builtin 方法。没有可引用来源的报告只能保留草案，不能伪装成已验证报告。报告不额外生成 report.md，使用 research show 阅读已保存 JSON。未做的测试与未知用量不得写为零或通过。

CLI 不理解文件是否真是市场材料。只有小说片段或原创方法时，文本定位假说保存为 analysis/craft；不能仅因 file 引文通过就将它包装成已完成市场取证。缺实际市场材料的 market 报告留 draft；作者提供的真实市场文件可以支持对应范围，仍须标日期、出处与未验证部分。

## 拆书与原创方法

拆书仅对作者提供或实际可访问材料进行，记录作品、来源、已读章节/片段和缺失部分。可提炼读者承诺、冲突或升级循环、场景转折、对白目的、信息揭露、长线推进和失效条件；开篇材料只能支持开篇判断，不能推断整本结构。

迁移时抽象机制，再为本书换成自己的目标、人物关系、世界条件和因果。不要搬用原作名字、句子、独特设定组合和标志性情节顺序，也不输出替代原作阅读的详细复述。引用只用于支持必要观察，短引文与分析分开保存。传闻、简介、摘录和完整已读正文须区分。

内置 craft profiles 是项目原创经验，覆盖玄幻升级、都市职业、悬疑推理、言情关系和历史权谋，不声称来自热榜统计或实证研究。每份包括读者承诺、冲突循环、场景、对白、长线推进、审阅问题、陷阱和作者定制。可以混合、调整或拒绝，不要求统一风格或固定爽点数量。

```powershell
node .specwriter/bin/specwriter.mjs craft list
node .specwriter/bin/specwriter.mjs craft show mystery-deduction
node .specwriter/bin/specwriter.mjs craft use mystery-deduction --as opening-method
```

use 将所选方法保存为本书 craft 报告和来源快照，供作者比较与章纲显式选用；不自动成为约定或审阅硬门槛。作者选择具体做法后，再整理入 Specs 或有范围的 instruction，按实际授权 adopt。

## 进入本章上下文

建议顺序：调研 → 拆书/题材方法 → 作者选定 → 完善并采用 Specs → 章纲选入资料 → 写章/审阅。作者已经在同一会话选定时直接落实，不重复确认。

章纲用独立的 references 数组，每项包含 id、purpose 和可选 revision，不放进 planPaths：

```json
{
  "references": [
    { "id": "market-opening", "purpose": "核对已选读者承诺的适配限制" },
    { "id": "opening-method", "purpose": "检查调查场景的认识变化" }
  ]
}
```

最多显式选入 8 份不同的本书已 save 报告；省略 revision 取最新已保存版本，需要固定时增加 research show 返回的64位 revision。purpose 说明本章为何需要它，不能把全库都当必须阅读。资料包包含报告、必要引文、引用位置及捕获来源元信息/路径，这些作为一个完整资料条目受上下文预算保护；完整捕获原文不全部内嵌，Codex 按来源路径读取核对所需原文。条目放不下时缩小选用范围或明确调整预算，不能悄悄删引文与来源保留结论。

选中实际报告版本或其绑定来源变化会影响 context hash；未固定版本的报告更新后重新 intent save、prepare --refresh 并提取审阅，固定旧版本不自动换成新报告。捕获来源不可变，修改或缺失会拒绝校验。未选资料的变化不应成为本章的隐式输入。选入 references 仍不把报告变成 canon、人物已知或本书事件；正文实际确立后才按记忆协议提取。
