const { spawn } = require("node:child_process");
const readline = require("node:readline");

class RetrievalClient {
  constructor({ pythonPath, servicePath, skillPath, onLog }) {
    this.pythonPath = pythonPath;
    this.servicePath = servicePath;
    this.skillPath = skillPath;
    this.onLog = onLog || (() => {});
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async start() {
    if (this.process) return;
    this.process = spawn(this.pythonPath, [this.servicePath, "--skill", this.skillPath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
      } catch (error) {
        this.onLog("retrieval", `invalid response: ${line.slice(0, 240)}`);
      }
    });
    readline.createInterface({ input: this.process.stderr }).on("line", (line) => this.onLog("retrieval", line));
    this.process.once("exit", (code) => {
      const error = new Error(`检索服务已退出 (${code})`);
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.process = null;
    });
    await this.call("health", {}, 30000);
  }

  call(method, params = {}, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) return reject(new Error("检索服务未启动"));
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`检索超时 (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
  }
}

module.exports = { RetrievalClient };
