const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_SESSIONS = 100;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT = 50000;
const MAX_HISTORY_BYTES = 12 * 1024 * 1024;

function cleanText(value, limit) {
  return String(value || "").replace(/\u0000/g, "").slice(0, limit);
}

function cleanId(value, fallback) {
  const text = String(value || "");
  return /^[a-zA-Z0-9-]{8,80}$/.test(text) ? text : fallback();
}

function normalizeMessage(value, idFactory) {
  if (!value || !["user", "assistant"].includes(value.role)) return null;
  return {
    id: cleanId(value.id, idFactory),
    role: value.role,
    text: cleanText(value.text, MAX_MESSAGE_TEXT),
    time: cleanText(value.time, 24),
    pending: false,
    error: Boolean(value.error),
  };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") return null;
  return {
    query: cleanText(value.query, 12000),
    retrieval_mode: cleanText(value.retrieval_mode, 80),
    detected_topic: cleanText(value.detected_topic, 120),
    elapsedMs: Math.max(0, Math.min(Number(value.elapsedMs || 0), 3600000)),
    results: Array.isArray(value.results) ? value.results.slice(0, 10).map((item) => ({
      pmid: cleanText(item?.pmid, 32),
      doi: cleanText(item?.doi, 240),
      title: cleanText(item?.title, 1000),
      year: cleanText(item?.year, 12),
      journal: cleanText(item?.journal, 300),
      evidence_level: cleanText(item?.evidence_level, 100),
      abstract_excerpt: cleanText(item?.abstract_excerpt, 5000),
      pubmed_url: /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i.test(String(item?.pubmed_url || "")) ? String(item.pubmed_url).slice(0, 500) : "",
    })) : [],
  };
}

function deriveTitle(messages) {
  const first = messages.find((message) => message.role === "user" && message.text.trim());
  if (!first) return "新会话";
  const title = first.text.replace(/\s+/g, " ").trim();
  return title.length > 30 ? `${title.slice(0, 30)}…` : title;
}

class HistoryStore {
  constructor(file, options = {}) {
    this.file = path.resolve(file);
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.encode = options.encode || ((value) => Buffer.from(value, "utf8"));
    this.decode = options.decode || ((value) => value.toString("utf8"));
  }

  readAll() {
    try {
      const stats = fs.statSync(this.file);
      if (stats.size > MAX_HISTORY_BYTES) return [];
      const value = JSON.parse(this.decode(fs.readFileSync(this.file)));
      if (!value || value.version !== 1 || !Array.isArray(value.sessions)) return [];
      return value.sessions.map((session) => this.normalizeSession(session)).filter(Boolean).slice(0, MAX_SESSIONS);
    } catch {
      return [];
    }
  }

  normalizeSession(value) {
    if (!value || typeof value !== "object") return null;
    const messages = (Array.isArray(value.messages) ? value.messages : [])
      .slice(-MAX_MESSAGES)
      .map((message) => normalizeMessage(message, this.idFactory))
      .filter(Boolean);
    const createdAt = /^\d{4}-\d{2}-\d{2}T/.test(String(value.createdAt || "")) ? String(value.createdAt) : this.now();
    const updatedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(value.updatedAt || "")) ? String(value.updatedAt) : createdAt;
    return {
      id: cleanId(value.id, this.idFactory),
      title: cleanText(value.title, 80) || deriveTitle(messages),
      createdAt,
      updatedAt,
      messages,
      evidence: normalizeEvidence(value.evidence),
    };
  }

  writeAll(sessions) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = JSON.stringify({ version: 1, sessions: sessions.slice(0, MAX_SESSIONS) }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > MAX_HISTORY_BYTES) throw new Error("聊天记录超过本地存储上限");
    const encoded = this.encode(payload);
    if (!Buffer.isBuffer(encoded) || encoded.length > MAX_HISTORY_BYTES + 1024 * 1024) throw new Error("聊天记录编码失败");
    fs.writeFileSync(temp, encoded, { mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
    } catch (error) {
      if (!fs.existsSync(temp)) throw error;
      fs.copyFileSync(temp, this.file);
      fs.unlinkSync(temp);
    }
  }

  list() {
    return this.readAll()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        preview: cleanText(session.messages.at(-1)?.text, 100),
      }));
  }

  get(id) {
    return this.readAll().find((session) => session.id === id) || null;
  }

  create() {
    const now = this.now();
    const session = { id: this.idFactory(), title: "新会话", createdAt: now, updatedAt: now, messages: [], evidence: null };
    const sessions = this.readAll().filter((item) => item.messages.length || item.title !== "新会话");
    this.writeAll([session, ...sessions]);
    return session;
  }

  save(value) {
    const sessions = this.readAll();
    const existing = sessions.find((session) => session.id === value?.id);
    const now = this.now();
    const normalized = this.normalizeSession({
      ...value,
      id: existing?.id || value?.id,
      createdAt: existing?.createdAt || value?.createdAt || now,
      updatedAt: now,
    });
    normalized.title = deriveTitle(normalized.messages);
    const next = [normalized, ...sessions.filter((session) => session.id !== normalized.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS);
    this.writeAll(next);
    return normalized;
  }
}

module.exports = { HistoryStore, MAX_HISTORY_BYTES, MAX_MESSAGES, MAX_SESSIONS };
