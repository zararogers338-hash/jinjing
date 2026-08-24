const http = require("node:http");
const crypto = require("node:crypto");
const { WebSearchService } = require("./web-search.cjs");

const MAX_GATEWAY_BODY_BYTES = 10 * 1024 * 1024;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validateProviderBaseUrl(value, { allowInsecureLocal = false } = {}) {
  const normalized = normalizeBaseUrl(value);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("API 地址不是有效 URL");
  }
  if (url.username || url.password) throw new Error("API 地址不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("API 地址不能包含查询参数或片段");
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(allowInsecureLocal && url.protocol === "http:" && localHost)) {
    throw new Error("第三方 API 必须使用 HTTPS");
  }
  return normalizeBaseUrl(url.toString());
}

function requiredTemperature(errorBody) {
  const match = String(errorBody || "").match(/invalid temperature:\s*only\s*(-?\d+(?:\.\d+)?)\s+is allowed/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

const REASONING_EFFORTS = new Set(["provider", "none", "low", "high", "max"]);

function normalizeReasoningEffort(value) {
  const effort = String(value || "provider").toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "provider";
}

function withChatReasoning(payload, settings) {
  const effort = normalizeReasoningEffort(settings?.reasoningEffort);
  if (effort === "provider") return payload;
  if (effort === "none") return { ...payload, thinking: { type: "disabled" } };
  return { ...payload, thinking: { type: "enabled" }, reasoning_effort: effort };
}

function withResponsesReasoning(payload, settings) {
  const effort = normalizeReasoningEffort(settings?.reasoningEffort);
  if (effort === "provider") return payload;
  return { ...payload, reasoning: { ...(payload.reasoning || {}), effort } };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.input_text || part?.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function responsesToMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input || "" }];
  for (const item of input) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (item.type === "message" || item.role) {
      const role = ["system", "developer", "user", "assistant"].includes(item.role)
        ? item.role
        : "user";
      const normalizedRole = role === "developer" ? "system" : role;
      const text = contentText(item.content);
      if (text) messages.push({ role: normalizedRole, content: text });
      continue;
    }
    if (item.type === "input_text" && item.text) messages.push({ role: "user", content: item.text });
    if (item.type === "function_call" && item.call_id) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: chatToolName(item.namespace, item.name), arguments: String(item.arguments || "{}") },
        }],
      });
    }
    if (item.type === "function_call_output" && item.call_id) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: contentText(item.output) || String(item.output || "") });
    }
  }
  return messages;
}

function chatToolName(namespace, name) {
  return [namespace, name].filter(Boolean).join("__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function responsesToolsToChat(tools) {
  const result = [];
  const lookup = new Map();
  for (const tool of tools || []) {
    if (tool?.type === "namespace" && tool.name && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (!child?.name) continue;
        const name = chatToolName(tool.name, child.name);
        lookup.set(name, { namespace: tool.name, name: child.name });
        result.push({ type: "function", function: { name, description: child.description || "", parameters: child.parameters || { type: "object", properties: {} } } });
      }
    } else if (tool?.type === "function" && tool.name) {
      const name = chatToolName(null, tool.name);
      lookup.set(name, { namespace: null, name: tool.name });
      result.push({ type: "function", function: { name, description: tool.description || "", parameters: tool.parameters || { type: "object", properties: {} } } });
    }
  }
  return { tools: result, lookup };
}

function extractAssistantText(payload) {
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (Array.isArray(choice?.message?.content)) return contentText(choice.message.content);
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output
      .flatMap((item) => item?.content || [])
      .map((part) => part?.text || "")
      .join("");
  }
  return "";
}

function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function makeResponsesSse(text, usage = {}) {
  const responseId = `resp_jinjing_${crypto.randomUUID().replaceAll("-", "")}`;
  const itemId = `msg_jinjing_${crypto.randomUUID().replaceAll("-", "")}`;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const events = [
    { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
    },
  ];
  if (text) events.push({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text });
  events.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  });
  events.push({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens,
      },
    },
  });
  return events.map(sseEvent).join("");
}

function makeFunctionResponsesSse(toolCalls, lookup, usage = {}) {
  const responseId = `resp_jinjing_${crypto.randomUUID().replaceAll("-", "")}`;
  const events = [{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } }];
  for (const call of toolCalls || []) {
    const resolved = lookup.get(call?.function?.name) || { namespace: null, name: call?.function?.name || "tool" };
    events.push({
      type: "response.output_item.done",
      item: {
        id: `fc_jinjing_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function_call",
        call_id: call.id || `call_${crypto.randomUUID().replaceAll("-", "")}`,
        ...(resolved.namespace ? { namespace: resolved.namespace } : {}),
        name: resolved.name,
        arguments: call?.function?.arguments || "{}",
        status: "completed",
      },
    });
  }
  events.push({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: {
        input_tokens: Number(usage.prompt_tokens || 0),
        output_tokens: Number(usage.completion_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0),
      },
    },
  });
  return events.map(sseEvent).join("");
}

class ThirdPartyGateway {
  constructor({ onLog, allowInsecureLocal = false } = {}) {
    this.server = null;
    this.port = null;
    this.settings = null;
    this.apiKey = "";
    this.token = crypto.randomBytes(24).toString("hex");
    this.onLog = onLog || (() => {});
    this.allowInsecureLocal = allowInsecureLocal;
    this.webSearch = new WebSearchService({ onLog: this.onLog });
  }

  async start(settings, apiKey) {
    await this.stop();
    this.settings = { ...settings, baseUrl: validateProviderBaseUrl(settings.baseUrl, { allowInsecureLocal: this.allowInsecureLocal }) };
    this.apiKey = apiKey;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    this.onLog("gateway", `listening on 127.0.0.1:${this.port}`);
    this.onLog("gateway", `reasoning effort: ${normalizeReasoningEffort(this.settings.reasoningEffort)}`);
    return { port: this.port, token: this.token };
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
  }

  async test(settings, apiKey) {
    const normalized = { ...settings, baseUrl: validateProviderBaseUrl(settings.baseUrl, { allowInsecureLocal: this.allowInsecureLocal }) };
    if (!normalized.baseUrl || !normalized.model || !apiKey) throw new Error("请完整填写 API 地址、模型和密钥");
    if (normalized.protocol === "responses") {
      const response = await fetch(`${normalized.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(withResponsesReasoning({ model: normalized.model, input: "Reply with OK", max_output_tokens: 8 }, normalized)),
      });
      if (!response.ok) throw new Error(`Provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return { ok: true, protocol: "responses", reasoningEffort: normalizeReasoningEffort(normalized.reasoningEffort) };
    }
    const result = await this.#postChat(normalized, apiKey, withChatReasoning({
      model: normalized.model,
      stream: false,
      max_tokens: 8,
      temperature: Number(normalized.temperature ?? 0.2),
      messages: [{ role: "user", content: "Reply with OK" }],
    }, normalized));
    if (!result.response.ok) throw new Error(`Provider ${result.response.status}: ${result.raw.slice(0, 500)}`);
    return {
      ok: true,
      protocol: "chat_completions",
      temperature: result.temperature,
      temperatureAdjusted: result.temperatureAdjusted,
      reasoningEffort: normalizeReasoningEffort(normalized.reasoningEffort),
    };
  }

  async #postChat(settings, apiKey, payload) {
    const send = async (body) => {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      return { response, raw: await response.text() };
    };

    let activePayload = payload;
    let result = await send(activePayload);
    const required = result.response.ok ? null : requiredTemperature(result.raw);
    let temperatureAdjusted = false;
    if (required !== null && activePayload.temperature !== required) {
      activePayload = { ...activePayload, temperature: required };
      temperatureAdjusted = true;
      this.onLog("gateway", `provider requires temperature ${required}; adjusted for this runtime`);
      result = await send(activePayload);
    }
    return { ...result, temperature: activePayload.temperature, temperatureAdjusted };
  }

  async #handle(req, res) {
    try {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unauthorized local gateway request" } }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > MAX_GATEWAY_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Local gateway request is too large" } }));
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_GATEWAY_BODY_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Local gateway request is too large" } }));
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url?.endsWith("/alpha/search")) {
        const result = await this.webSearch.run(body.commands || {});
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      if (this.settings.protocol === "responses") await this.#forwardResponses(body, res);
      else await this.#translateChat(body, res);
    } catch (error) {
      this.onLog("gateway", error.stack || error.message);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  }

  async #forwardResponses(body, res) {
    const upstream = await fetch(`${this.settings.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(withResponsesReasoning({ ...body, model: this.settings.model, stream: true }, this.settings)),
    });
    if (!upstream.ok) throw new Error(`Provider ${upstream.status}: ${(await upstream.text()).slice(0, 1000)}`);
    res.writeHead(200, { "content-type": upstream.headers.get("content-type") || "text/event-stream", "cache-control": "no-cache" });
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }

  async #translateChat(body, res) {
    const translatedTools = responsesToolsToChat(body.tools);
    const payload = withChatReasoning({
      model: this.settings.model,
      messages: responsesToMessages(body),
      stream: false,
      temperature: this.settings.temperature ?? 0.2,
    }, this.settings);
    if (translatedTools.tools.length) {
      payload.tools = translatedTools.tools;
      payload.tool_choice = "auto";
    }
    if (body.max_output_tokens) payload.max_tokens = body.max_output_tokens;
    const result = await this.#postChat(this.settings, this.apiKey, payload);
    const { response: upstream, raw } = result;
    if (result.temperatureAdjusted) this.settings.temperature = result.temperature;
    if (!upstream.ok) throw new Error(`Provider ${upstream.status}: ${raw.slice(0, 1000)}`);
    const json = JSON.parse(raw);
    const toolCalls = json?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      res.end(makeFunctionResponsesSse(toolCalls, translatedTools.lookup, json.usage));
      return;
    }
    const text = extractAssistantText(json);
    if (!text) throw new Error("第三方模型返回了空响应");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    res.end(makeResponsesSse(text, json.usage));
  }
}

module.exports = {
  ThirdPartyGateway,
  MAX_GATEWAY_BODY_BYTES,
  normalizeBaseUrl,
  validateProviderBaseUrl,
  normalizeReasoningEffort,
  requiredTemperature,
  responsesToMessages,
  extractAssistantText,
  makeResponsesSse,
  makeFunctionResponsesSse,
  chatToolName,
  responsesToolsToChat,
  withChatReasoning,
  withResponsesReasoning,
};
