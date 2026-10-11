# SpecWriter

SpecWriter 是面向 Codex 的长篇小说创作工作流，WriterMemory 是其长期记忆模块。通过创作约定、滚动计划、正文审阅和有证据的记忆提交，帮助 Agent 在新会话和长篇写作中恢复人物、伏笔与剧情状态。

当前已经实现本地 CLI、7 个 Codex Skills、4 份创作约定模板、版本化的正文和记忆提交闭环，以及本地小说阅读器。WriterMemory 默认使用 Microsoft GraphRAG 检索，并保留带证据的结构化状态与显式离线模式。

v0.5 统一已登记人物的别名与状态/资源身份，将章纲纳入上下文校验，加强证据分类和审阅契约；Microsoft GraphRAG 支持隔离的增量索引、进度/恢复/清理及正文引用映射。阅读进度和偏好保存在小说目录，重启服务后继续阅读。

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
- [记忆实验、用量与质量评估](packages/specwriter/assets/benchmark.md)
- [小说阅读、批注与导出](packages/specwriter/assets/reader.md)
- [复用代码与许可证](packages/specwriter/THIRD_PARTY_NOTICES.md)

## 目录结构

```text
SpecWriter/
├── packages/specwriter/
│   ├── src/          # CLI、WriterMemory、GraphRAG 与阅读服务
│   ├── assets/       # Codex Skills、协议、创作模板与本地阅读器
│   ├── schemas/      # 提取与审阅契约
│   ├── examples/     # 离线演示及 GraphRAG 兼容检查
│   ├── test/         # 工作流、记忆与阅读器回归测试
│   └── licenses/     # 复用代码许可证
├── docs/             # 架构与数据边界说明
├── .hallmark/        # 本地阅读器设计记录
├── package.json      # 仓库工作区与开发命令
├── package-lock.json
└── LICENSE.txt
```

运行依赖 `node_modules/` 和编译产物 `packages/specwriter/dist/` 自动生成，不纳入版本控制。小说正文、创作约定和记忆数据库由 init 在独立小说目录创建。

```powershell
npm test
npm run check
npm run demo
npm run demo:long
npm.cmd run benchmark
npm run reader:demo
```

要求 Node.js 24+。Codex 负责创作、提取和审阅；默认 Microsoft GraphRAG 提供向量、图和社区摘要检索，按已接纳章节前缀独立索引。正式状态和中文 SQLite FTS5/BM25 继续提供可核对的依据。阅读器仅在本机运行，MCP 和直接编辑正文的 Web 界面尚未实现。
