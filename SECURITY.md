# Security Policy

## Supported release

当前支持 `0.1.x` Windows x64 发行版。只从本仓库的 GitHub Release 下载，并在安装前核对随附的 SHA-256 清单。

## Report a vulnerability

请通过 GitHub Security Advisory 私下报告漏洞，不要在公开 Issue 中附上 API 密钥、患者信息、可利用样例或其他敏感数据。报告应包含受影响版本、复现步骤、实际影响和建议修复。

## Data handling

- 模型 API 密钥通过 Electron `safeStorage` 在本机加密保存。
- 聊天记录同样通过 `safeStorage` 加密保存，并限制会话数、消息数和单条长度。
- 附件在本机提取文本并受数量、类型和大小限制；仅在用户发起请求时进入模型上下文。
- 联网 Agent 会把查询和必要上下文发送给所配置的搜索目标与第三方模型。
- 工作区和设置保存在 Electron 用户数据目录，不写入安装目录。

不要输入可识别患者身份的信息。若用于真实科研数据，使用前应完成机构伦理、数据治理和第三方处理协议审查。

## Known distribution limitation

公开测试版安装器目前未使用项目方代码签名证书签名，因此 Windows SmartScreen 可能提示未知发布者。该限制不影响哈希核验，但正式面向临床机构部署前应使用可信 EV/OV 证书签名安装器与主程序。
