# 小说版本、备份与迁移

在小说根目录使用本地启动器。Git 必须已安装；不需要远程仓库或账号。

```text
node .specwriter/bin/specwriter.mjs version init
node .specwriter/bin/specwriter.mjs version save --message "卷一完成"
node .specwriter/bin/specwriter.mjs version log
node .specwriter/bin/specwriter.mjs version bundle --out E:\backups\book-20261011.bundle
node .specwriter/bin/specwriter.mjs version restore HEAD --to E:\novels\recovered
node .specwriter/bin/specwriter.mjs version restore HEAD --bundle E:\backups\book-20261011.bundle --to E:\novels\migrated
```

`version init` 启用当前小说的独立裸 Git 仓库 `.specwriter/version/repository.git`，保存首次检查点，并设置 config.versioning.enabled/autoSave=true。以后每次接纳章节、同步正文投影成功后自动保存。不会操作作者已有仓库的工作区、暂存区、hooks 或 remote，不自动 push。需要关闭自动保存时设置 autoSave=false；关闭后仍可手动 save。

检查点包含 Spec、计划、正文、草稿、审阅、阅读批注、项目 Skills 和 SQLite 一致性副本。数据库使用 VACUUM INTO，包括尚在 WAL 中的已提交数据；不能直接复制运行中的 writer.db。保存前要求正文投影一致；有未接纳的手工改动时先 sync --capture 保留为草稿。保存拒绝符号链接、嵌套仓库和不可迁移的文件名。保存期间不要另行编辑作者文档。

每 20 个检查点增量打包近期 Git 对象，压缩重复的数据库副本；不删除历史，不每章重打包全库。空间节省取决于实际变更，百万字规模仍需实测。打包失败返回 maintenanceWarning，已保存检查点仍然有效。

`.env`、常见 credentials/secrets 文件、配置中已知的密钥值、模型权重、GraphRAG 索引/缓存/日志、生成的 exports 不进入检查点。模型名称及 provider 名称只用于恢复提示；API Key、端点和 Python 路径在新机器配置。不要把其他秘密粘入正文或 Spec；检查点和 bundle 包含未发表小说及历史草稿，不加密。

数据库接纳与 Git 保存是两个阶段。`versionNeedsSave=true` 表示章节已经接纳，Git 保存失败；修复后 version save，不能重复 commit 当作补救。投影失败先 sync 再保存。残留 operation.lock 的 PID 必须确认已经停止后再人工移除；不要删除正在操作的锁。

restore 只接受 HEAD 或提交哈希，目标必须是原小说之外的新目录。逐文件核对哈希、字节数、路径，检查数据库完整性、书籍 ID、generation 和正式正文一致性；完成验证和独立 Git 克隆之后才发布目标目录。原小说和历史保留；恢复旧提交时另存源历史末端引用，后续 bundle 仍包含较新的检查点。

bundle 导出完整 Git 历史，已有同名文件拒绝覆盖。迁移时在新机器先安装构建 SpecWriter，再使用其 CLI 执行 version restore --bundle；不需要原书籍数据库。本地启动器会绑定当前安装。恢复后用 doctor/status 检查，再配置生成模型和本地 BGE-M3；GraphRAG 索引按需重新建立，可能产生模型调用费用。最后重新 export 交付小说。

检索 receipt 与派生索引一起排除；已接纳正文的审阅和 context 保留在数据库中。未接纳草稿若依赖这些 receipt，status 会提示 needsRefresh；配置后 prepare --refresh 保留正文并重新取回上下文、提取和审阅。

本地 Git 历史用于回退；真正的异地备份需要把 bundle 保存到另一块磁盘或其他可靠存储。仅在小说磁盘内保存仓库无法抵御整盘损坏。
