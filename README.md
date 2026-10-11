# SpecWriter

SpecWriter 是面向 Codex 的长篇小说创作工作流，WriterMemory 是其长期记忆模块。通过创作约定、滚动计划、正文审阅和有证据的记忆提交，帮助 Agent 在新会话和长篇写作中恢复人物、伏笔与剧情状态。

当前已经实现本地 CLI、7 个 Codex Skills、4 份创作约定模板、版本化的正文和记忆提交闭环，以及本地小说阅读器。WriterMemory 默认使用 Microsoft GraphRAG 检索，并保留带证据的结构化状态与显式离线模式。

```powershell
npm install
npm run build
node packages/specwriter/dist/cli.js init E:\novels\my-book --name "我的小说"
```

然后在 Codex 中打开小说目录，使用 `$specwriter-propose`、`$specwriter-write`、`$specwriter-commit` 等 Skills，或直接用自然语言安排创作。

阅读写好的小说，在小说目录运行 `node .specwriter/bin/specwriter.mjs read`。浏览器提供章节目录、草稿预览、字号/行距、夜间阅读、段落批注和版本对照。按“复制给 Codex”把意见带回对话，或直接让 Codex 读取批注修订。`export --format txt|md|html` 导出正式作品；阅读和导出不调用模型。

默认后端需要 Python >=3.11,<3.14、`graphrag==3.3.0` 和模型凭据。运行 `memory graphrag setup --python EXE --model MODEL --embedding MODEL` 初始化供应商配置。第一章没有历史正文，跳过索引与模型检索；从第二章起 prepare 自动索引已接纳前缀并取回语义记忆。详见下方记忆文档。离线体验可在 init 时加 `--backend local`。

- [安装、命令与使用说明](packages/specwriter/README.md)
- [架构与数据边界](docs/specwriter-architecture.md)
- [记忆记录与 GraphRAG 接入](packages/specwriter/assets/memory.md)
- [小说阅读、批注与导出](packages/specwriter/assets/reader.md)
- [复用代码与许可证](packages/specwriter/THIRD_PARTY_NOTICES.md)

```powershell
npm test
npm run check
npm run demo
npm run reader:demo
```

要求 Node.js 24+。Codex 负责创作、提取和审阅；默认 Microsoft GraphRAG 提供向量、图和社区摘要检索，按已接纳章节前缀独立索引。正式状态和中文 SQLite FTS5/BM25 继续提供可核对的依据。阅读器仅在本机运行，MCP 和直接编辑正文的 Web 界面尚未实现。

项目代码位于 `packages/specwriter`。仓库原有 `frontend` 与 `backend` 是小说转剧本原型，保留供后续评估复用；历史说明见 [旧项目文档](docs/legacy-awesomewriter.md)。它们不参与 SpecWriter 的构建和测试。
