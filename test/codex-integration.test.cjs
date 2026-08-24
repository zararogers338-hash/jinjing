const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { ThirdPartyGateway } = require("../electron/gateway.cjs");
const { CodexAppServerClient } = require("../electron/app-server-client.cjs");

function resolveCodex() {
  if (process.env.JINJING_CODEX_TEST_EXE) return process.env.JINJING_CODEX_TEST_EXE;
  if (process.platform === "win32") {
    const globalRoot = path.join(process.env.APPDATA, "npm", "node_modules");
    const npmBinary = path.join(
      globalRoot,
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    if (fs.existsSync(npmBinary)) return npmBinary;
    const matches = execFileSync("where.exe", ["codex.exe"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (matches.length) return matches[0];
  }
  return "codex";
}

const CODEX = resolveCodex();
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");

test("Codex App Server completes a turn through the third-party compatibility gateway", { timeout: 60000 }, async () => {
  assert.ok(fs.existsSync(CODEX), "Codex native binary is required for this integration test");
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "晋京端到端模拟回答 [PMID: 27162233]" } }],
      usage: { prompt_tokens: 120, completion_tokens: 12 },
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const gateway = new ThirdPartyGateway({ allowInsecureLocal: true });
  await gateway.start({
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    model: "mock-third-party",
    protocol: "chat_completions",
  }, "test-provider-key");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinjing-codex-"));
  const events = [];
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const client = new CodexAppServerClient({
    codexPath: CODEX,
    codexHome: path.join(root, "codex-home"),
    skillRoot: path.join(WORKSPACE_ROOT, "outputs", "jinjing"),
    skillPath: path.join(WORKSPACE_ROOT, "outputs", "jinjing", "SKILL.md"),
    workspacePath: path.join(root, "workspace"),
    instructionsPath: path.join(__dirname, "..", "resources", "instructions.md"),
    gateway,
    model: "mock-third-party",
    onLog: (_source, message) => events.push({ method: "stderr", message }),
    onEvent: (event) => {
      events.push(event);
      if (event.method === "turn/completed") complete(event);
    },
  });
  try {
    await client.start();
    await client.send("请依据附加的本地证据回答 ACL 问题");
    let timer;
    const done = await Promise.race([
      completed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`turn/completed timeout: ${JSON.stringify(events.slice(-12))}`)), 30000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(done.params.turn.status, "completed");
    const serialized = JSON.stringify(events);
    assert.match(serialized, /晋京端到端模拟回答|item\/agentMessage\/delta/);
  } finally {
    await client.stop();
    await gateway.stop();
    await new Promise((resolve) => provider.close(resolve));
  }
});
