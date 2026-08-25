# 晋京 Jinjing 0.1.1 发行审计报告

审计日期：2026-08-25  
目标平台：Windows 10/11 x64  
结论：**通过，可作为研究测试版发行**。唯一重要发行限制是项目方主程序和安装器尚未使用受信任代码签名证书签名，Windows SmartScreen 可能提示未知发布者。

## 1. 最终发行物

| 项目 | 结果 |
|---|---:|
| 安装器 | `Jinjing-Setup.exe` |
| 安装器大小 | 1,767,972,934 字节 |
| 安装器 SHA-256 | `fb1cc5e1816bd03d21a0fb8108031b8f3aaeb9f9fd60112bb3df3473eeb4797b` |
| 应用版本 | Jinjing 0.1.1 |
| Electron | 43.4.1 |
| Codex CLI / App Server | 0.147.0 |
| Python | 3.11.9 embedded x64 |
| PyTorch | 2.13.0+cpu |
| 本地嵌入模型 | BAAI BGE-M3，CPU，1024 维 |
| 离线数据库 | SQLite/FTS5，943,693,824 字节 |

最终 SFX 归档完整性测试通过：2,023 个目录、22,853 个文件（含安装助手），解压总量 4,753,944,241 字节。SFX 外壳显式嵌入 `asInvoker` manifest，安装不需要管理员权限。

## 2. 安装、路径与完整性

- 从最终单文件 EXE 安装到含中文和空格的路径 `...\0.1.1 final2 安装\晋京`，退出码为 0。
- 实际应用树为 22,852 个载荷文件、4,753,923,249 字节；安装器另生成 `INSTALL-LOCATION.txt`。
- 对最终安装树的 22,852 个载荷文件逐一比较相对路径、大小和 SHA-256，差异为 0。
- 文件清单 SHA-256：`73c98dd957a576834df2a6b9557216a2766595a7281e4a33d7765f84eb53d33b`。
- 最长相对路径 154 字符，低于发行门槛 180 字符。
- 安装器使用无边框黑色界面，中央白色“晋”字，具有 Windows 11 圆角、细线进度、安装中关闭保护与标准键盘 Tab 顺序。

## 3. 离线文库与模型

从最终安装目录运行嵌入式 Python，并强制 Hugging Face/Transformers 离线模式：

| 检查项 | 结果 |
|---|---:|
| PubMed 记录 | 76,139 |
| 有摘要记录 | 72,402 |
| BGE-M3 向量 | 76,139 |
| 模型元数据 | `BAAI/bge-m3:dense-cls-f16` |
| 测试向量形状 | 1 × 1024 |
| 测试向量 L2 norm | 1.0 |

数据库、模型权重、Python 运行时和检索服务全部在安装目录内，基础离线检索不需要联网下载。

## 4. 聊天记录回归

- 新增本地会话列表、新建会话、切换会话、继续对话与 300 ms 防抖自动保存。
- 历史限制为最多 100 个会话、每个 200 条消息、单条 50,000 字符；仅接受 `user` / `assistant` 角色。
- 安装版首次启动实际生成 `chat-history.json`，文件头为 `JH1E`，磁盘上不包含“新会话”明文。
- 使用同版本 Electron 与 Windows `safeStorage` 只读解密成功：格式版本 1，会话数 1。
- 应用关闭后使用同一用户数据重启，再次解密仍为 1 个会话，未因解密失败重复新建。
- 4 项历史存储单元测试覆盖消息保存/重载/排序、数据清洗、损坏或超限文件闭锁、加密编解码边界。

## 5. 功能与安全回归

- Node 自动化测试：24/24 通过。
- Vite/Electron Windows x64 生产构建通过，主程序 `FileVersion` 为 0.1.1。
- 从最终 `app.asar` 反提取 `main.cjs`、`preload.cjs`和 `history-store.cjs`，与源码 SHA-256 全部一致。
- Electron 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；静态扫描无不安全 Electron 配置命中。
- 源码扫描无 API Key 样式命中；测试密钥未进入源码、安装包或 Git。
- 历史恢复只向新 Agent 线程注入最后 16 条、最多 24,000 字符的用户/助手上下文，并显式声明不能改变系统安全边界。

## 6. 供应链与签名

| 检查 | 结果 |
|---|---:|
| `npm audit`（全依赖） | 0 漏洞 |
| npm 生产依赖树 | 完整 |
| Python `pip-audit` | 41 个包，0 已知漏洞 |
| npm CycloneDX SBOM | 121 个组件，根版本 0.1.1 |
| Python CycloneDX SBOM | 41 个组件 |

Authenticode 状态：

- `codex.exe`：Valid，OpenAI OpCo, LLC。
- `python.exe`：Valid，Python Software Foundation。
- `Jinjing.exe`：NotSigned。
- `Jinjing-Setup.exe`：NotSigned。

正式机构发行前建议使用可信 OV/EV 证书签名主程序与安装器，并在签名后重新计算哈希。

## 7. 已知限制

- 下载约 1.65 GiB，安装后约 4.43 GiB；安装期间建议保留至少 10 GiB 可用空间。
- 建议至少 8 GB 内存；BGE-M3 首次 CPU 加载比后续检索慢。
- 离线文献库是固定快照，不自动更新。
- 联网搜索和模型综合依赖用户配置的第三方服务，其可用性、隐私和计费由相应服务决定。
- 工具用于科研、教学和文献检索，不替代临床诊断、处方、手术决策或紧急处置。

## 8. 结论

在未使用项目方代码签名证书这一已披露限制下，Jinjing 0.1.1 的现代黑色安装器、中文/空格路径、完整离线载荷、BGE-M3 推理、SQLite 文库、加密聊天记录、第三方模型网关与安全边界均达到研究测试版发行标准。
