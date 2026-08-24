# 晋京 Jinjing 0.1.0

首个 Windows x64 研究测试版。

## 内容

- 单文件普通用户安装器，内含完整离线运行时
- 76,139 条 PubMed 运动医学记录与 76,139 个 BGE-M3 向量
- 本地混合检索、证据面板和 PMID 回溯
- 只连接用户配置的第三方模型 API
- Chat Completions / Responses、思考强度和多步 Agent
- 公网搜索、页面打开/查找，带 SSRF 防护
- PDF、DOCX 和文本类附件；拖放或文件选择
- 浅色/深色极简桌面界面

## 安装

下载 `Jinjing-Setup.exe`，先核对 `SHA256SUMS.txt`，再双击安装。默认位置为 `%LOCALAPPDATA%\Programs\Jinjing`。安装后在 Settings 中配置第三方模型 Base URL、Model ID 和 API Key。

## 已知限制

安装器与 Jinjing 主程序尚未使用项目方代码签名证书，Windows SmartScreen 可能提示未知发布者。完整审计结果见 `AUDIT-REPORT.md`。

