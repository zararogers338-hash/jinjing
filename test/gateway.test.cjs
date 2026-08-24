const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { ThirdPartyGateway, responsesToMessages, makeResponsesSse, responsesToolsToChat, validateProviderBaseUrl, withChatReasoning, withResponsesReasoning } = require("../electron/gateway.cjs");

test("Third-party provider URLs require HTTPS outside explicit local tests", () => {
  assert.equal(validateProviderBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.throws(() => validateProviderBaseUrl("http://api.example.com/v1"), /HTTPS/);
  assert.throws(() => validateProviderBaseUrl("https://user:secret@api.example.com/v1"), /用户名或密码/);
  assert.equal(validateProviderBaseUrl("http://127.0.0.1:1234/v1", { allowInsecureLocal: true }), "http://127.0.0.1:1234/v1");
});

test("Reasoning controls map to Chat Completions and Responses payloads", () => {
  assert.deepEqual(withChatReasoning({ model: "x" }, { reasoningEffort: "none" }), { model: "x", thinking: { type: "disabled" } });
  assert.deepEqual(withChatReasoning({ model: "x" }, { reasoningEffort: "max" }), { model: "x", thinking: { type: "enabled" }, reasoning_effort: "max" });
  assert.deepEqual(withResponsesReasoning({ model: "x" }, { reasoningEffort: "high" }), { model: "x", reasoning: { effort: "high" } });
});

test("Responses input is reduced to third-party chat messages", () => {
  const messages = responsesToMessages({
    instructions: "Be concise",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Use evidence" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "ACL?" }] },
    ],
  });
  assert.deepEqual(messages, [
    { role: "system", content: "Be concise" },
    { role: "system", content: "Use evidence" },
    { role: "user", content: "ACL?" },
  ]);
});

test("Codex namespace tools and their history translate to Chat Completions", () => {
  const translated = responsesToolsToChat([{ type: "namespace", name: "web", tools: [{ type: "function", name: "run", description: "Search", parameters: { type: "object" } }] }]);
  assert.equal(translated.tools[0].function.name, "web__run");
  assert.deepEqual(translated.lookup.get("web__run"), { namespace: "web", name: "run" });
  const messages = responsesToMessages({ input: [
    { type: "function_call", call_id: "call-1", namespace: "web", name: "run", arguments: "{\"search_query\":[]}" },
    { type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "Search result" }] },
  ] });
  assert.equal(messages[0].tool_calls[0].function.name, "web__run");
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call-1", content: "Search result" });
});

test("Synthetic Responses stream has a terminal completion", () => {
  const body = makeResponsesSse("离线证据回答", { prompt_tokens: 4, completion_tokens: 6 });
  assert.match(body, /response\.output_text\.delta/);
  assert.match(body, /response\.output_item\.done/);
  assert.match(body, /response\.completed/);
  assert.match(body, /"total_tokens":10/);
});

test("Chat-completions provider is translated behind the local Responses endpoint", async () => {
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer provider-secret");
    assert.equal(request.model, "third-party-model");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "模拟回答" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;
  const gateway = new ThirdPartyGateway({ allowInsecureLocal: true });
  await gateway.start({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: "third-party-model", protocol: "chat_completions" }, "provider-secret");
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }] }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /模拟回答/);
  await gateway.stop();
  await new Promise((resolve) => provider.close(resolve));
});

test("Codex standalone web endpoint is authenticated and forwarded locally", async () => {
  const gateway = new ThirdPartyGateway();
  await gateway.start({ baseUrl: "https://provider.invalid/v1", model: "third-party-model", protocol: "responses" }, "provider-secret");
  gateway.webSearch.run = async (commands) => ({ encrypted_output: "", output: `searched ${commands.search_query[0].q}`, results: [] });
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/alpha/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ commands: { search_query: [{ q: "sports medicine" }] } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output, "searched sports medicine");
  const rejected = await fetch(`http://127.0.0.1:${gateway.port}/v1/alpha/search`, { method: "POST", body: "{}" });
  assert.equal(rejected.status, 401);
  await gateway.stop();
});

test("Chat provider tool calls are returned to Codex as namespaced Responses events", async () => {
  let requestBody;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-7", type: "function", function: { name: "web__run", arguments: "{\"search_query\":[{\"q\":\"ACL\"}]}" } }] } }] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const gateway = new ThirdPartyGateway({ allowInsecureLocal: true });
  await gateway.start({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: "tool-model", protocol: "chat_completions" }, "provider-secret");
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text: "Search ACL" }] }],
      tools: [{ type: "namespace", name: "web", tools: [{ type: "function", name: "run", description: "Search", parameters: { type: "object" } }] }],
    }),
  });
  const sse = await response.text();
  assert.equal(requestBody.tools[0].function.name, "web__run");
  assert.match(sse, /"namespace":"web"/);
  assert.match(sse, /"name":"run"/);
  assert.match(sse, /"call_id":"call-7"/);
  await gateway.stop();
  await new Promise((resolve) => provider.close(resolve));
});

test("Chat-completions retries with a provider-mandated temperature", async () => {
  const seenTemperatures = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seenTemperatures.push(request.temperature);
    res.writeHead(request.temperature === 1 ? 200 : 400, { "content-type": "application/json" });
    res.end(request.temperature === 1
      ? JSON.stringify({ choices: [{ message: { content: "temperature accepted" } }] })
      : JSON.stringify({ error: { type: "invalid_request_error", message: "invalid temperature: only 1 is allowed for this model" } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const gateway = new ThirdPartyGateway({ allowInsecureLocal: true });
  const result = await gateway.test({
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    model: "fixed-temperature-model",
    protocol: "chat_completions",
    temperature: 0.2,
  }, "provider-secret");
  assert.equal(result.ok, true);
  assert.equal(result.temperatureAdjusted, true);
  assert.equal(result.temperature, 1);
  assert.deepEqual(seenTemperatures, [0.2, 1]);
  await new Promise((resolve) => provider.close(resolve));
});
