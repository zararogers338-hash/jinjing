const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "/"));
}

function writeCodexConfig({ codexHome, model, gatewayPort, instructionsPath, internetAccess = true }) {
  fs.mkdirSync(codexHome, { recursive: true });
  const config = [
    `model = ${tomlString(model)}`,
    'model_provider = "jinjing-gateway"',
    `model_instructions_file = ${tomlString(instructionsPath)}`,
    `web_search = "${internetAccess ? "live" : "disabled"}"`,
    'approval_policy = "never"',
    "",
    "[features]",
    "shell_tool = false",
    `standalone_web_search = ${internetAccess ? "true" : "false"}`,
    "plugins = false",
    "remote_models = false",
    "",
    "[tools]",
    `web_search = ${internetAccess ? "true" : "false"}`,
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[model_providers.jinjing-gateway]",
    'name = "Jinjing Local Third-Party Gateway"',
    `base_url = "http://127.0.0.1:${gatewayPort}/v1"`,
    'env_key = "JINJING_GATEWAY_TOKEN"',
    'wire_api = "responses"',
    `supports_standalone_web_search = ${internetAccess ? "true" : "false"}`,
    "requires_openai_auth = false",
    "request_max_retries = 1",
    "stream_max_retries = 1",
    "stream_idle_timeout_ms = 180000",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), config, "utf8");
}

class CodexAppServerClient {
  constructor({ codexPath, codexHome, skillRoot, skillPath, workspacePath, instructionsPath, gateway, model, internetAccess = true, onEvent, onLog }) {
    Object.assign(this, { codexPath, codexHome, skillRoot, skillPath, workspacePath, instructionsPath, gateway, model, internetAccess });
    this.onEvent = onEvent || (() => {});
    this.onLog = onLog || (() => {});
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threadId = null;
    this.turnId = null;
    this.ready = false;
  }

  async start() {
    await this.stop();
    writeCodexConfig({
      codexHome: this.codexHome,
      model: this.model,
      gatewayPort: this.gateway.port,
      instructionsPath: this.instructionsPath,
      internetAccess: this.internetAccess,
    });
    fs.mkdirSync(this.workspacePath, { recursive: true });
    this.process = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.workspacePath,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        JINJING_GATEWAY_TOKEN: this.gateway.token,
        LOG_FORMAT: "json",
        RUST_LOG: "warn",
      },
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.#receive(line));
    readline.createInterface({ input: this.process.stderr }).on("line", (line) => this.onLog("codex", line));
    this.process.once("exit", (code) => {
      const error = new Error(`Codex App Server 已退出 (${code})`);
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.ready = false;
      this.process = null;
      this.onEvent({ type: "runtime", status: "error", message: error.message });
    });
    await this.request("initialize", {
      clientInfo: { name: "jinjing", title: "Jinjing Sports Medicine", version: "0.1.0" },
      capabilities: {},
    });
    this.notify("initialized", {});
    await this.request("skills/extraRoots/set", { extraRoots: [this.skillRoot] });
    this.ready = true;
    this.onEvent({ type: "runtime", status: "ready", message: "Codex ready" });
  }

  request(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) return reject(new Error("Codex App Server 未启动"));
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async newThread() {
    const response = await this.request("thread/start", {
      model: this.model,
      cwd: this.workspacePath,
      ephemeral: false,
    });
    this.threadId = response.thread.id;
    this.turnId = null;
    return response.thread;
  }

  async send(text) {
    if (!this.threadId) await this.newThread();
    const response = await this.request("turn/start", {
      threadId: this.threadId,
      cwd: this.workspacePath,
      input: [
        { type: "text", text, textElements: [] },
        { type: "skill", name: "jinjing", path: this.skillPath },
      ],
    }, 180000);
    this.turnId = response.turn.id;
    return response.turn;
  }

  async interrupt() {
    if (!this.threadId || !this.turnId) return;
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  async stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.ready = false;
    this.threadId = null;
    this.turnId = null;
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onLog("codex", `invalid JSONL: ${line.slice(0, 300)}`);
      return;
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
    if (message.method) {
      if (Object.hasOwn(message, "id")) {
        this.process.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Client request not supported" } })}\n`);
      }
      this.onEvent({ type: "notification", method: message.method, params: message.params || {} });
    }
  }
}

module.exports = { CodexAppServerClient, writeCodexConfig };
