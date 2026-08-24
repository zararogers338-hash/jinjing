const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeCodexConfig } = require("../electron/app-server-client.cjs");

test("Codex config only declares the local third-party gateway", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinjing-config-"));
  writeCodexConfig({ codexHome: dir, model: "vendor-model", gatewayPort: 43210, instructionsPath: "C:/Jinjing/instructions.md" });
  const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.match(config, /model_provider = "jinjing-gateway"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:43210\/v1"/);
  assert.match(config, /web_search = "live"/);
  assert.match(config, /standalone_web_search = true/);
  assert.match(config, /supports_standalone_web_search = true/);
  assert.doesNotMatch(config, /api\.openai\.com|OPENAI_API_KEY/);
});

test("Codex web access can be disabled as one configuration boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinjing-config-off-"));
  writeCodexConfig({ codexHome: dir, model: "vendor-model", gatewayPort: 43210, instructionsPath: "C:/Jinjing/instructions.md", internetAccess: false });
  const config = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /standalone_web_search = false/);
  assert.match(config, /supports_standalone_web_search = false/);
});
