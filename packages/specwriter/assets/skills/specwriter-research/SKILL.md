---
name: specwriter-research
description: 为 SpecWriter 小说查阅近期市场、平台榜单与读者定位，保存有日期和来源的研究报告及备选方向。用于创作前或方向调整的市场调研，不自动采用设定。
---

先运行 status，读取本书已有约定及作者的调研问题。按 [研究协议](references/research.md) 用 research create/capture/save 管理资料；本次只查所需平台、时间窗与读者范围。报告回答作者问题，区分可核对观察、有限推断、备选方向和未知项。

当前信息用 Codex 可用的联网搜索/浏览工具查证并打开直接来源；没有工具或页面不可读时明确来源不足，可继续用作者材料，不能伪造最新排名或数据。CLI research radar 仅抓番茄/起点公开榜单快照，无额外搜索 API Key，不是 Qwen 或通用联网搜索能力。详细取证与代表性判断按需读 [市场证据](references/market-evidence.md)。

将实际读取的必要文本捕获为来源，记录日期、URL、可见范围和限制，填写 CLI 返回的 draft 路径再 save。quote/hash 校验不能替代语义核对；没有来源的市场报告保留草案。以少量有区别的选项说明对本书的收益、代价和适配，不把榜单相关性写成收益保证。

来源角色也要核对：只有小说片段或 craft 方法时，可以保存文本定位假说的 analysis/craft 报告，不能因 file 引文通过校验就把它当市场取证。缺实际市场材料的 market 报告留 draft；作者提供的榜单、评论或其他市场文件可支持相应范围，仍不冒充已验证当前数据。

交付保存路径、来源范围、判断限制和供作者决定的方向。作者已经选定时由 explore/propose 落实；否则保持研究报告，不自动改 Specs、instruction、canon 或写作授权。只有明确选入章纲 references 的本书已保存报告进入本章资料包，研究文本不进入默认 GraphRAG。

据研究调整本书下一阶段或历史剧情时，先按 [生命周期核查](references/lifecycle.md) 完成 plan，涉及旧章另做 impact；实际读本书出处并保存判断。纯外部市场取证仍用研究库，不把它当本书正式历史。已有有效材料复用，有证据缺口才查；空历史不调用 GraphRAG。
