晋京 Jinjing 0.1.1
====================

启动
----
双击 Jinjing.exe。

首次使用
--------
1. 打开 SETTINGS / API settings。
2. 填写第三方服务的 Base URL、Model ID 和 API Key。
3. 选择接口协议：多数兼容服务选择 Chat Completions；原生支持 Responses API 的服务选择 Responses。
4. 点击 TEST CONNECTION，成功后点击 SAVE & RESTART。

离线文库
--------
- 76,139 条运动医学 PubMed 记录
- 72,402 条摘要
- 76,139 个 BGE-M3 稠密向量
- SQLite / FTS5 / BM25 / BGE-M3 / RRF 混合检索
- BGE-M3 模型、数据库和 Python 运行时均已包含在本目录

第一次语义检索需要把 BGE-M3 载入内存，通常比后续查询慢。EVIDENCE 页面不需要配置模型 API，也可直接检索本地文库。

系统要求
--------
- Windows 10/11 x64
- 建议至少 8 GB 内存
- 应用目录需要保留完整；不要只复制 Jinjing.exe

安全与边界
----------
- API Key 使用 Windows 系统加密存储，不写入本目录或运行日志。
- Codex 只连接本机临时网关；网关再连接用户配置的第三方模型。
- 本地文库是固定快照，日常使用不会自动下载或更新。
- 输出仅用于信息与研究辅助，不替代急诊诊断、个体化处方或最终参赛许可。

许可证和数据说明见 LICENSES、resources\jinjing\references\data-use.md。
