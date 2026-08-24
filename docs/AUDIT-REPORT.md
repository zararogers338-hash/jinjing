# 晋京 Jinjing 0.1.0 发行审计报告

审计日期：2026-08-25  
目标平台：Windows 10/11 x64  
结论：**通过，可作为研究测试版发行**。唯一重要发行限制是项目方主程序和安装器尚未使用受信任代码签名证书签名，Windows SmartScreen 可能提示未知发布者。

## 1. 发行物与运行时

| 项目 | 结果 |
|---|---:|
| 正式安装器 | `Jinjing-Setup.exe`，1,602,637,557 字节 |
| 安装器 SHA-256 | `f6d9662e1dec905021215a988bf25976a5b3dcb96add790906f01dd817d26c7e` |
| 应用版本 | Jinjing 0.1.0 |
| Electron | 43.4.1 |
| Codex CLI / App Server | 0.147.0 |
| Python | 3.11.9 embedded x64 |
| PyTorch | 2.13.0+cpu；包元数据 2.13.0 |
| setuptools | 84.0.0 |
| 本地嵌入模型 | BAAI BGE-M3，CPU，1024 维 |
| 离线数据库 | SQLite/FTS5，943,693,824 字节 |

安装器内嵌 2,023 个目录和 22,853 个文件（含安装助手），7-Zip 归档完整性测试通过。实际应用树为 22,852 个文件、4,753,911,018 字节，最长相对路径 154 字符，低于发行门槛 180 字符。

## 2. 安装与路径审计

- 在普通用户权限下，从最终单文件 EXE 安装成功，退出码为 0；没有请求管理员权限。
- 测试路径包含中文和空格：`...\最终 安装测试\晋京 Release`。
- 对暂存应用树和实际安装树的 22,852 个文件逐个比较相对路径、大小和 SHA-256，差异为 0。
- 安装器按设计额外生成 `INSTALL-LOCATION.txt`。一次打包后 Python 审计在暂存目录生成的单个 `__pycache__` 文件不在内嵌归档中，复审时作为明确例外排除。
- 完整逐文件清单位于 `PAYLOAD-FILE-MANIFEST.tsv`，自身 SHA-256 为 `893694286b22d01059d2bbb32873d3fe757123e63b7ca9cda64d300e71024960`。
- 默认安装路径：`%LOCALAPPDATA%\Programs\Jinjing`。
- 用户配置、加密密钥与工作区：`%APPDATA%\jinjing-desktop`。
- 安装临时解压目录由 7-Zip 在 `%TEMP%` 下建立；安装日志为 `%TEMP%\Jinjing-Setup.log`。
- 发行脚本拒绝非 `app` 根目录、相对路径超过 180 字符、最终 EXE 达到 4 GiB、根目录/嵌套安装路径和非空目标目录。

审计中发现原 SFX 外壳没有显式权限清单，Windows 会因文件名中的 “Setup” 启用安装器检测并要求 UAC。已为 SFX 外壳嵌入 `asInvoker` manifest，修复后重新生成、测试和安装。

## 3. 离线文库与模型回归

从实际安装目录运行嵌入式 Python，且强制 Hugging Face/Transformers 离线模式：

| 检查项 | 结果 |
|---|---:|
| PubMed 记录 | 76,139 |
| 有摘要记录 | 72,402 |
| BGE-M3 向量 | 76,139 |
| 测试向量形状 | 1 × 1024 |
| 测试向量 L2 norm | 1.0 |

数据库、模型权重、Python 运行时和检索服务均包含于安装目录，基础离线检索不依赖联网下载。

## 4. 功能回归

- Node 自动化测试：20/20 通过，包括附件解析、第三方网关、Responses/Chat Completions 转换、思考强度、Codex App Server、联网工具和 SSRF 边界。
- 生产 Web 构建：Vite 190 modules，构建通过。
- 最终安装版 GUI：`READY`、`LIBRARY READY`、`WEB READY` 均出现。
- 第三方模型：DeepSeek 配置被正确读取，思考强度显示 `HIGH`；发行包不预置任何 API 密钥。
- 输入框：真实键盘注入中文成功，文本可见，`RUN` 从禁用变为可用。
- 联网 Agent：同一应用 payload 的真实 DeepSeek 多步测试已完成搜索、打开网页、综合回答和 PMID 证据显示。
- 附件：PDF/DOCX/文本等解析测试通过；数量上限 5 个、单文件 15 MiB。原生文件选择器入口已验证能打开；Windows 自动化未重复执行最终模态文件选择，拖放和解析边界由代码/自动化测试覆盖。
- 浅色/深色、设置页滚动、API 配置和 Evidence 面板在最终候选 payload 上通过；最终 EXE 只额外修复 SFX 权限清单，应用 payload 未改变。

## 5. 应用安全边界

- Electron：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 所有渲染器导航被拦截；只允许通过主进程打开 HTTP(S) 外部链接；权限请求默认拒绝。
- API Key 使用 Electron `safeStorage` 加密保存在用户数据目录，未写入源码、数据库、日志、安装包或 Git。
- 生产模型端点必须为 HTTPS，不允许 URL 内用户名/密码、query 或 fragment；仅自动化测试可显式放开本机 HTTP。
- 本机网关只监听 `127.0.0.1`，使用随机 bearer token，请求体上限 10 MiB。
- 网络工具解析 DNS 并拒绝 localhost、私网、链路本地和保留 IPv4/IPv6；每次重定向重新验证；响应体上限 2 MiB；每轮最多 10 次网络工具调用。
- 附件在复制 Buffer 前检查声明大小；文件名取 basename；限制数量、大小、文本长度，并中和 Markdown 三反引号提示边界。
- 用户问题截断到 12,000 字符；空问题被拒绝。
- 源码和 `app.asar` 扫描未发现 API 密钥、私钥、用户绝对路径、`eval`、`new Function`、`dangerouslySetInnerHTML` 或 shell 子进程。

## 6. 供应链与签名

| 检查 | 结果 |
|---|---:|
| `npm audit`（开发与生产） | 0 漏洞 |
| npm 生产依赖树 | 完整，无 invalid/missing |
| Python `pip-audit` | 41 个依赖，0 已知漏洞 |
| npm CycloneDX SBOM | 131 个生产组件，CycloneDX 1.6 |
| Python CycloneDX SBOM | 41 个组件 |

Electron 已从 37 升级到 43.4.1。Python 审计发现的旧 setuptools 81 漏洞已通过升级到 84.0.0 修复；过期的 `torch-2.11.0+cpu.dist-info` 已移除，实际运行时与元数据统一为 PyTorch 2.13.0。

Authenticode 状态：

- `codex.exe`：Valid，OpenAI OpCo, LLC。
- `python.exe`：Valid，Python Software Foundation。
- `Jinjing.exe`：NotSigned。
- `Jinjing-Setup.exe`：NotSigned。

正式机构发行前建议使用可信 OV/EV 证书签名 `Jinjing.exe` 与安装器，并在签名后重新计算哈希。

## 7. 已知限制与部署要求

- 下载约 1.49 GiB，安装后约 4.43 GiB；安装期间建议至少保留 10 GiB 可用磁盘空间。
- 建议至少 8 GB 内存；BGE-M3 首次 CPU 加载比后续检索慢。
- 离线文献库是固定快照，不自动更新；文献版权与记录级使用条件见包内 `data-use.md`。
- 联网搜索和模型综合依赖用户配置的第三方服务，其可用性、隐私和计费由相应服务决定。
- 工具用于科研、教学和文献检索，不替代临床诊断、处方、手术决策或紧急处置。

## 8. 结论

在无代码签名证书这一已披露限制下，Jinjing 0.1.0 的安装、路径、依赖、离线模型、文库、第三方模型网关、联网 Agent、附件、安全边界和退出清理均达到研究测试版发行标准。源码、构建脚本、审计脚本和报告已备份到私有 GitHub 仓库，二进制通过 GitHub Release 分发并配套 SHA-256 与 SBOM。

