import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

const NAV = [
  ["chat", "会话", "CHAT"],
  ["evidence", "证据", "EVIDENCE"],
  ["library", "文库", "LIBRARY"],
  ["trace", "轨迹", "TRACE"],
  ["settings", "设置", "SETTINGS"],
];

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function runtimeLabel(status) {
  return {
    ready: "READY",
    starting: "STARTING",
    unconfigured: "CONFIGURE",
    error: "ERROR",
    offline: "OFFLINE",
  }[status] || String(status || "OFFLINE").toUpperCase();
}

function reasoningLabel(value) {
  return { provider: "DEFAULT", none: "OFF", low: "LOW", high: "HIGH", max: "MAX" }[value] || "DEFAULT";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function EvidenceCard({ item, index, compact = false }) {
  const open = (event) => {
    event.preventDefault();
    if (item.pubmed_url) window.jinjing.openExternal(item.pubmed_url);
  };
  return (
    <article className={`evidence-card ${compact ? "compact" : ""}`}>
      <div className="evidence-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="evidence-body">
        <a href={item.pubmed_url || "#"} onClick={open} className="evidence-title">{item.title}</a>
        <div className="evidence-meta">
          <span>{item.year || "N.D."}</span><span>{item.journal || "UNKNOWN"}</span><span>{item.evidence_level}</span>
        </div>
        {!compact && item.abstract_excerpt && <p>{item.abstract_excerpt}</p>}
        <div className="evidence-id">PMID {item.pmid}{item.doi ? ` / DOI ${item.doi}` : ""}</div>
      </div>
    </article>
  );
}

function StatusDot({ status }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function Header({ page, setPage, theme, setTheme, state, openPalette }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => setPage("chat")}>
        <span className="brand-mark">晋</span>
        <span className="brand-name">晋京 <i>JINJING</i></span>
      </button>
      <nav className="topnav" aria-label="主导航">
        {NAV.map(([id, , en]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>{en}</button>)}
      </nav>
      <button className="command-trigger" onClick={openPalette}><span>search or run a command</span><kbd>CTRL K</kbd></button>
      <div className="top-status">
        <span className="provider-status"><StatusDot status={state.runtimeStatus} />{state.provider?.model || "THIRD-PARTY"} / {runtimeLabel(state.runtimeStatus)}</span>
        <button className="theme-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换明暗主题">{theme === "dark" ? "LIGHT" : "DARK"}</button>
      </div>
    </header>
  );
}

function SideRail({ page, setPage, state, newThread }) {
  return (
    <aside className="side-rail">
      <div className="rail-label">PROJECT</div>
      <button className={page === "chat" ? "rail-item active" : "rail-item"} onClick={() => setPage("chat")}><b>01</b> Current study</button>
      <button className="rail-item" onClick={newThread}><b>02</b> New session</button>
      <div className="rail-label runtime-label">RUNTIME</div>
      <button className={page === "evidence" ? "rail-item active" : "rail-item"} onClick={() => setPage("evidence")}><b>03</b> Evidence graph</button>
      <button className={page === "library" ? "rail-item active" : "rail-item"} onClick={() => setPage("library")}><b>04</b> Offline library</button>
      <button className={page === "trace" ? "rail-item active" : "rail-item"} onClick={() => setPage("trace")}><b>05</b> Runtime trace</button>
      <button className={page === "settings" ? "rail-item active" : "rail-item"} onClick={() => setPage("settings")}><b>06</b> API settings</button>
      <div className="rail-footer">
        <div>JINJING / {state.version || "0.1.0"}</div>
        <div>LOCAL EVIDENCE RUNTIME</div>
        <div className="rail-health"><StatusDot status={state.evidenceStatus} /> LIBRARY {runtimeLabel(state.evidenceStatus)}</div>
      </div>
    </aside>
  );
}

function Markdown({ children }) {
  return <ReactMarkdown components={{ a: ({ href, children: label }) => <a href={href} onClick={(e) => { e.preventDefault(); window.jinjing.openExternal(href); }}>{label}</a> }}>{children}</ReactMarkdown>;
}

function ChatPage({ state, messages, evidence, stage, sending, send, interrupt, setPage }) {
  const [text, setText] = useState(() => sessionStorage.getItem("jinjing-draft") || "");
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  useEffect(() => {
    const pane = scrollRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [messages, stage]);
  const updateText = (value) => {
    setText(value);
    sessionStorage.setItem("jinjing-draft", value);
  };
  const submit = (event) => {
    event.preventDefault();
    const value = text.trim() || (attachments.length ? "请分析所附文件，并结合可靠证据回答。" : "");
    if (!value || sending || state.runtimeStatus !== "ready" || attachmentStatus === "正在解析附件…") return;
    updateText("");
    const files = attachments;
    setAttachments([]);
    setAttachmentStatus("");
    send({ text: value, attachments: files });
  };
  const addFiles = async (fileList) => {
    const available = Math.max(0, 5 - attachments.length);
    const files = Array.from(fileList || []).slice(0, available);
    if (!files.length) return;
    setAttachmentStatus("正在解析附件…");
    const parsed = [];
    const failures = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        parsed.push(await window.jinjing.extractAttachment({ name: file.name, type: file.type, bytes }));
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    setAttachments((old) => [...old, ...parsed].slice(0, 5));
    setAttachmentStatus(failures.length ? failures.join(" / ") : parsed.length ? `已在本机解析 ${parsed.length} 个文件` : "");
  };
  const drop = async (event) => {
    event.preventDefault();
    setDragging(false);
    await addFiles(event.dataTransfer.files);
  };
  return (
    <div className="chat-layout">
      <main className="chat-main">
        <div className="page-heading chat-heading">
          <div><div className="breadcrumb">~/jinjing/session</div><h1>会话</h1><p>本地文献检索 · 第三方模型</p></div>
          <span className={`state-badge ${sending ? "active" : ""}`}>{sending ? stage.message || "WORKING" : state.settings?.internetAccess !== false ? "WEB READY" : runtimeLabel(state.runtimeStatus)}</span>
        </div>
        <div className="chat-scroll" ref={scrollRef}>
          {!messages.length && (
            <section className="empty-state">
              <div className="empty-copy">
                <span className="eyebrow">JINJING</span>
                <h2>运动医学循证助手</h2>
                <p>输入问题，或拖入 PDF、DOCX 与文本文件。</p>
              </div>
            </section>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-label">{message.role === "user" ? "YOU" : "JINJING"}<span>{message.time}</span></div>
              <div className="message-content"><Markdown>{message.text || (message.pending ? "_等待响应…_" : "")}</Markdown></div>
            </article>
          ))}
          {sending && <div className="working-line"><span /><span /><span /> {stage.message || "处理中"}</div>}
        </div>
        <form className={`composer ${dragging ? "dragging" : ""}`} onSubmit={submit} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }} onDrop={drop}>
          {!!attachments.length && <div className="attachment-strip">{attachments.map((file, index) => <div className="attachment-chip" key={`${file.name}-${index}`}><span><b>{file.name}</b><small>{formatBytes(file.size)}{file.truncated ? " / TRUNCATED" : ""}</small></span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((old) => old.filter((_item, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>}
          {dragging && <div className="drop-hint">DROP FILES / 本机解析</div>}
          <textarea value={text} onChange={(e) => updateText(e.target.value)} placeholder="输入运动医学问题…  Enter 发送 / Shift+Enter 换行" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && state.runtimeStatus === "ready") submit(e); }} />
          <div className="composer-bar">
            <div className="composer-tools"><input ref={fileInputRef} type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.pdf,.docx" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} /><button type="button" className="file-button" onClick={() => fileInputRef.current?.click()}>＋ FILE</button><span><b>BGE-M3</b> / {state.settings?.internetAccess !== false ? "WEB LIVE" : "WEB OFF"} / {state.settings?.multiStepAgent !== false ? "AGENT" : "DIRECT"} / THINK {reasoningLabel(state.settings?.reasoningEffort)}</span></div>
            {sending
              ? <button type="button" className="stop-button" onClick={interrupt}>STOP</button>
              : state.runtimeStatus === "ready"
                ? <button type="submit" disabled={!text.trim() && !attachments.length}>RUN ↵</button>
                : <button type="button" onClick={() => setPage("settings")}>SETTINGS</button>}
          </div>
          {attachmentStatus && <div className={`attachment-status ${attachmentStatus.includes(":") ? "error" : ""}`}>{attachmentStatus}</div>}
        </form>
      </main>
      <aside className="evidence-drawer">
        <div className="drawer-header"><div><b>Evidence context</b><span>{evidence?.retrieval_mode || "NOT SEARCHED"}</span></div><button onClick={() => setPage("evidence")}>EXPAND</button></div>
        {!evidence?.results?.length ? <div className="drawer-empty">提出问题后，命中的本地文献会在这里出现。</div> : evidence.results.map((item, index) => <EvidenceCard compact key={item.pmid} item={item} index={index} />)}
      </aside>
    </div>
  );
}

function EvidencePage({ lastEvidence, onSearch }) {
  const [query, setQuery] = useState(lastEvidence?.query || "");
  const [result, setResult] = useState(lastEvidence);
  const [loading, setLoading] = useState(false);
  const run = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try { setResult(await onSearch({ query, topK: 10 })); } finally { setLoading(false); }
  };
  return (
    <main className="page-shell">
      <div className="page-heading"><div><div className="breadcrumb">~/jinjing/evidence</div><h1>Evidence graph</h1><p>直接查询离线 SQLite / FTS5 / BGE-M3，不需要模型 API。</p></div><span className={`state-badge ${loading ? "active" : ""}`}>{loading ? "RETRIEVING" : result?.retrieval_mode || "OFFLINE"}</span></div>
      <form className="evidence-search" onSubmit={run}><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ACL return to sport criteria…" /><button>SEARCH LOCAL ↵</button></form>
      {result && <div className="result-summary"><span>QUERY / {result.query}</span><span>TOPIC / {result.detected_topic || "CORPUS-WIDE"}</span><span>TIME / {result.elapsedMs || 0} MS</span><span>MODE / {result.retrieval_mode}</span></div>}
      <section className="evidence-list">{result?.results?.map((item, index) => <EvidenceCard key={item.pmid} item={item} index={index} />)}</section>
    </main>
  );
}

function LibraryPage({ state }) {
  const stats = state.libraryStats || {};
  const rows = [
    ["PUBMED PAPERS", formatNumber(stats.papers), "Relational citations"],
    ["ABSTRACTS", formatNumber(stats.abstracts), "Locally searchable text"],
    ["BGE-M3 VECTORS", formatNumber(stats.embeddings), "1024-D float16 dense vectors"],
    ["DATABASE", `${(Number(stats.databaseBytes || 0) / 1024 / 1024).toFixed(1)} MiB`, "SQLite + FTS5 + relations"],
    ["ENCODER", stats.modelPresent ? "BUNDLED" : "MISSING", stats.modelLoaded ? "Model loaded in memory" : "Lazy load on first semantic search"],
  ];
  return (
    <main className="page-shell">
      <div className="page-heading"><div><div className="breadcrumb">~/jinjing/library</div><h1>Offline library</h1><p>Versioned local corpus with no ordinary-use network dependency.</p></div><span className="state-badge active">VERIFIED</span></div>
      <section className="capability-list">
        {rows.map(([name, value, note], index) => <div className="capability-row" key={name}><div className="capability-name"><b>{name}</b><p>{note}</p></div><code>{String(index + 1).padStart(2, "0")} / JINJING</code><strong>{value}</strong><span className="enabled">ENABLED</span></div>)}
      </section>
      <div className="library-note"><b>SNAPSHOT INVARIANT</b><p>日常问答只读取已打包数据库，不会自动下载、更新或创建空库。引文必须来自本地检索结果。</p></div>
    </main>
  );
}

function TracePage({ logs }) {
  return (
    <main className="page-shell trace-page">
      <div className="page-heading"><div><div className="breadcrumb">~/jinjing/trace</div><h1>Runtime trace</h1><p>本地进程状态，不显示或记录第三方 API 密钥。</p></div><span className="state-badge">LOCAL ONLY</span></div>
      <div className="trace-table"><div className="trace-head"><span>TIME</span><span>SOURCE</span><span>EVENT</span></div>{logs.length ? logs.slice().reverse().map((entry, index) => <div className="trace-row" key={`${entry.at}-${index}`}><time>{entry.at.slice(11, 23)}</time><b>{entry.source}</b><pre>{entry.message}</pre></div>) : <div className="trace-empty">NO RUNTIME EVENTS</div>}</div>
    </main>
  );
}

function SettingsPage({ initial, save, test, state }) {
  const [form, setForm] = useState(initial || {});
  const [feedback, setFeedback] = useState(null);
  useEffect(() => setForm(initial || {}), [initial]);
  const update = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setFeedback({ type: "working", text: "保存并重启运行时…" });
    try { await save(form); setForm((old) => ({ ...old, apiKey: "", keyConfigured: true })); setFeedback({ type: "ok", text: "配置已保存，运行时已重启。" }); }
    catch (error) { setFeedback({ type: "error", text: error.message }); }
  };
  const probe = async () => {
    setFeedback({ type: "working", text: "正在直接测试第三方端点…" });
    try {
      const response = await test(form);
      const adjustment = response.temperatureAdjusted ? ` / temperature ${response.temperature} (AUTO)` : "";
      setFeedback({ type: "ok", text: `连接成功 / ${response.protocol}${adjustment}` });
    }
    catch (error) { setFeedback({ type: "error", text: error.message }); }
  };
  return (
    <main className="page-shell settings-page">
      <div className="page-heading"><div><div className="breadcrumb">~/jinjing/settings</div><h1>Third-party model</h1><p>配置 API 地址、模型和密钥。</p></div><span className={`state-badge ${state.runtimeStatus === "ready" ? "active" : ""}`}>{runtimeLabel(state.runtimeStatus)}</span></div>
      <form className="settings-form" onSubmit={submit}>
        <section className="settings-section"><div className="section-number">01</div><div className="section-copy"><h2>PROVIDER</h2><p>支持 Responses API，或常见的 OpenAI-compatible Chat Completions。</p></div><div className="fields">
          <label><span>DISPLAY NAME</span><input value={form.providerName || ""} onChange={update("providerName")} placeholder="Kimi / DeepSeek / SiliconFlow" /></label>
          <label><span>BASE URL</span><input value={form.baseUrl || ""} onChange={update("baseUrl")} placeholder="https://api.example.com/v1" /></label>
          <label><span>MODEL ID</span><input value={form.model || ""} onChange={update("model")} placeholder="moonshot-v1-128k" /></label>
          <label><span>PROTOCOL</span><select value={form.protocol || "chat_completions"} onChange={update("protocol")}><option value="chat_completions">Chat Completions (compatible)</option><option value="responses">Responses API (native)</option></select></label>
          <label className="wide"><span>API KEY {form.keyConfigured ? "/ ENCRYPTED KEY PRESENT" : ""}</span><input type="password" value={form.apiKey || ""} onChange={update("apiKey")} placeholder={form.keyConfigured ? "留空以保留现有密钥" : "sk-…"} autoComplete="new-password" /></label>
        </div></section>
        <section className="settings-section"><div className="section-number">02</div><div className="section-copy"><h2>EVIDENCE</h2><p>语义检索默认在本机完成，模型不会直接读取整个数据库。</p></div><div className="fields">
          <label><span>TOP K / {form.topK || 5}</span><input type="range" min="2" max="10" value={form.topK || 5} onChange={update("topK")} /></label>
          <label><span>TEMPERATURE / {form.temperature ?? 0.2}</span><input type="range" min="0" max="1" step="0.1" value={form.temperature ?? 0.2} onChange={update("temperature")} /></label>
          <label className="wide"><span>THINKING EFFORT</span><select value={form.reasoningEffort || "provider"} onChange={update("reasoningEffort")}><option value="provider">PROVIDER DEFAULT</option><option value="none">OFF</option><option value="low">LOW</option><option value="high">HIGH</option><option value="max">MAX</option></select></label>
          <label className="switch-field wide"><input type="checkbox" checked={Boolean(form.lexicalOnly)} onChange={update("lexicalOnly")} /><span>LEXICAL-ONLY ABLATION</span><small>关闭 BGE-M3，仅使用 FTS5/BM25；用于速度对照或评测。</small></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.internetAccess !== false} onChange={update("internetAccess")} /><span>LIVE INTERNET / CODEX WEB</span><small>开放 Codex 原生实时搜索、网页打开和页内查找；仅访问公网 HTTP(S)，阻止本机与内网地址。</small></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.multiStepAgent !== false} onChange={update("multiStepAgent")} /><span>MULTI-STEP AGENT</span><small>按本地检索、联网查证、证据审阅、最终回答执行；不展示内部思维链。</small></label>
        </div></section>
        <div className="settings-actions"><button type="button" onClick={probe}>TEST CONNECTION</button><button type="submit" className="primary">SAVE & RESTART</button>{feedback && <span className={`feedback ${feedback.type}`}>{feedback.text}</span>}</div>
      </form>
      <div className="security-note"><b>SECURITY / LOCAL BOUNDARY</b><p>密钥通过 Electron safeStorage 使用 Windows 系统加密后落盘；Codex 只看到一次性的本地网关令牌。运行日志不会输出真实密钥。</p></div>
    </main>
  );
}

function CommandPalette({ open, close, setPage, newThread, theme, setTheme }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  if (!open) return null;
  const commands = [...NAV.map(([id, zh, en]) => ({ label: `GO / ${en} — ${zh}`, run: () => setPage(id) })), { label: "NEW / 新建会话", run: newThread }, { label: `THEME / ${theme === "dark" ? "LIGHT" : "DARK"}`, run: () => setTheme(theme === "dark" ? "light" : "dark") }].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  return <div className="palette-backdrop" onMouseDown={close}><div className="palette" onMouseDown={(e) => e.stopPropagation()}><div className="palette-input"><span>›</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a command…" /><kbd>ESC</kbd></div><div className="palette-results">{commands.map((item) => <button key={item.label} onClick={() => { item.run(); close(); }}>{item.label}<span>↵</span></button>)}</div></div></div>;
}

export default function App() {
  const [page, setPage] = useState("chat");
  const [theme, setTheme] = useState(() => localStorage.getItem("jinjing-theme") || "light");
  const [state, setState] = useState({ runtimeStatus: "starting", evidenceStatus: "starting", provider: {} });
  const [settings, setSettings] = useState({});
  const [messages, setMessages] = useState([]);
  const [evidence, setEvidence] = useState(null);
  const [stage, setStage] = useState({ stage: "idle", message: "" });
  const [sending, setSending] = useState(false);
  const [logs, setLogs] = useState([]);
  const [palette, setPalette] = useState(false);
  const assistantId = useRef(null);

  const refresh = useCallback(async () => {
    const [nextState, nextSettings, nextLogs] = await Promise.all([window.jinjing.getState(), window.jinjing.getSettings(), window.jinjing.getLogs()]);
    setState((old) => ({ ...old, ...nextState, settings: nextSettings }));
    setSettings(nextSettings);
    setLogs(nextLogs);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("jinjing-theme", theme); }, [theme]);
  useEffect(() => {
    const key = (event) => { if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(true); } if (event.key === "Escape") setPalette(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const preventFileNavigation = (event) => event.preventDefault();
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => { window.removeEventListener("dragover", preventFileNavigation); window.removeEventListener("drop", preventFileNavigation); };
  }, []);
  useEffect(() => window.jinjing.onEvent((event) => {
    if (event.type === "runtime") setState((old) => ({ ...old, runtimeStatus: event.status }));
    if (event.type === "evidence-runtime") setState((old) => ({ ...old, evidenceStatus: event.status, libraryStats: event.stats || old.libraryStats }));
    if (event.type === "log") setLogs((old) => [...old.slice(-399), event.entry]);
    if (event.type === "chat-stage") { setStage(event); setSending(true); }
    if (event.type === "chat-evidence") setEvidence(event.evidence);
    if (event.type === "chat-delta" && event.delta) {
      setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, text: message.text + event.delta, pending: false } : message));
    }
    if (event.type === "chat-item" && event.text) {
      setMessages((old) => old.map((message) => message.id === assistantId.current && !message.text ? { ...message, text: event.text, pending: false } : message));
    }
    if (event.type === "chat-complete") { setSending(false); setStage({ stage: "idle", message: "" }); setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, pending: false } : message)); }
    if (event.type === "chat-error") { setSending(false); setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, text: `运行失败：${event.message}`, pending: false, error: true } : message)); }
  }), []);

  const send = useCallback(async (payload) => {
    const text = String(payload?.text || "").trim();
    if (!text || sending) return;
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const attachmentLine = payload.attachments?.length ? `\n\n附件：${payload.attachments.map((item) => item.name).join("、")}` : "";
    const userMessage = { id: crypto.randomUUID(), role: "user", text: `${text}${attachmentLine}`, time: now };
    const agentMessage = { id: crypto.randomUUID(), role: "assistant", text: "", time: now, pending: true };
    assistantId.current = agentMessage.id;
    setMessages((old) => [...old, userMessage, agentMessage]);
    setSending(true);
    setStage({ stage: "retrieving", message: "正在检索离线证据" });
    try { await window.jinjing.sendMessage({ ...payload, text }); }
    catch (error) { setSending(false); setMessages((old) => old.map((message) => message.id === agentMessage.id ? { ...message, text: `运行失败：${error.message}`, pending: false, error: true } : message)); }
  }, [sending]);

  const newThread = useCallback(async () => { await window.jinjing.newThread(); setMessages([]); setEvidence(null); setPage("chat"); }, []);
  const saveSettings = async (value) => { const saved = await window.jinjing.saveSettings(value); setSettings(saved); await refresh(); return saved; };
  const content = useMemo(() => {
    if (page === "chat") return <ChatPage state={{ ...state, settings }} messages={messages} evidence={evidence} stage={stage} sending={sending} send={send} interrupt={() => window.jinjing.interrupt()} setPage={setPage} />;
    if (page === "evidence") return <EvidencePage lastEvidence={evidence} onSearch={async (params) => { const result = await window.jinjing.searchEvidence(params); setEvidence(result); return result; }} />;
    if (page === "library") return <LibraryPage state={state} />;
    if (page === "trace") return <TracePage logs={logs} />;
    return <SettingsPage initial={settings} save={saveSettings} test={(value) => window.jinjing.testSettings(value)} state={state} />;
  }, [page, state, settings, messages, evidence, stage, sending, send, logs]);

  return <div className="app-frame"><Header page={page} setPage={setPage} theme={theme} setTheme={setTheme} state={state} openPalette={() => setPalette(true)} /><div className="app-body"><SideRail page={page} setPage={setPage} state={state} newThread={newThread} />{content}</div><CommandPalette open={palette} close={() => setPalette(false)} setPage={setPage} newThread={newThread} theme={theme} setTheme={setTheme} /></div>;
}
