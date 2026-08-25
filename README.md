# 晋京 Jinjing

晋京是一个面向广义运动医学的 Windows 桌面检索与研究客户端。它在本地用 BGE-M3 检索离线文献库，再由用户配置的第三方模型综合证据；应用本身不绑定 OpenAI 模型服务。

## 主要能力

- 76,139 条离线 PubMed 记录，72,402 篇摘要，76,139 个 BGE-M3 向量
- 本地语义检索、证据上下文与 PMID 回溯
- 兼容 Chat Completions / Responses 风格的第三方模型 API
- 独立联网搜索、网页打开与页面内查找，带 SSRF 和响应大小限制
- 多步 Agent、思考强度、浅色/深色模式
- 使用 Windows 系统加密持久化聊天记录，可新建、切换并继续历史会话
- PDF、DOCX、TXT、Markdown、CSV、TSV、JSON、XML、HTML 附件
- 内置 Codex CLI、Python 3.11 CPU 运行时与完整离线检索资源

## 开发

需要 Node.js 20+。开发仓库不包含大型离线语料、模型与运行时；它们由发行暂存脚本注入。

```powershell
npm ci
npm test
npm run dev
```

构建 Web/Electron 目录版：

```powershell
npm run build
```

完整发行包使用 `scripts/stage-portable.ps1` 暂存运行时，再用 `scripts/build-release-installer.ps1` 生成 Windows x64 单文件安装器。构建脚本会拒绝超长归档路径、超过 PE 附加数据限制的安装器和错误的 payload 根目录。

## 安全边界

渲染进程启用 `contextIsolation` 与 sandbox，并关闭 Node 集成。第三方 API 密钥使用 Electron `safeStorage` 加密后保存在用户数据目录，既不进入源码仓库，也不写入离线库。生产环境只接受 HTTPS 模型端点；网络工具会阻止本机、私网、链路本地地址及重定向绕过。

详见 [SECURITY.md](SECURITY.md)。

## 医疗声明

晋京用于文献检索、科研与教学，不替代医生的诊断、处方、手术决策或紧急医疗处置。模型输出必须回到原始文献和个体临床资料核验。

## 许可证

源代码采用 Apache License 2.0。随发行包分发的第三方组件、模型和文献元数据保留其各自许可证与使用条款。
