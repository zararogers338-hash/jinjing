const path = require("node:path");

const ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".pdf", ".docx"]);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 40000;

async function parseAttachment(payload) {
  const name = path.basename(String(payload?.name || "attachment"));
  const type = String(payload?.type || "application/octet-stream").slice(0, 120);
  const extension = path.extname(name).toLowerCase();
  if (!ATTACHMENT_EXTENSIONS.has(extension)) throw new Error(`不支持的附件类型：${extension || type}`);
  const declaredBytes = Number(payload?.bytes?.byteLength ?? payload?.bytes?.length ?? 0);
  if (!Number.isFinite(declaredBytes) || declaredBytes > MAX_ATTACHMENT_BYTES) throw new Error("单个附件不能超过 15 MiB");
  const buffer = Buffer.from(payload?.bytes || []);
  if (!buffer.length) throw new Error("附件为空");
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("单个附件不能超过 15 MiB");
  let text = "";
  if (extension === ".pdf") {
    const pdf = require("pdf-parse");
    text = (await pdf(buffer)).text || "";
  } else if (extension === ".docx") {
    const mammoth = require("mammoth");
    text = (await mammoth.extractRawText({ buffer })).value || "";
  } else if (extension === ".html" || extension === ".htm") {
    const { load } = require("cheerio");
    const $ = load(buffer.toString("utf8"));
    $("script,style,noscript,svg,canvas").remove();
    text = $("body").text();
  } else {
    text = buffer.toString("utf8");
  }
  text = text.replace(/\0/g, "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("附件中没有可提取的文本");
  return { name, type, size: buffer.length, text: text.slice(0, MAX_ATTACHMENT_TEXT), truncated: text.length > MAX_ATTACHMENT_TEXT };
}

function normalizeAttachmentList(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 5) throw new Error("每轮最多上传 5 个附件");
  return value.map((item) => ({
    name: path.basename(String(item?.name || "attachment")).slice(0, 240),
    type: String(item?.type || "application/octet-stream").slice(0, 120),
    size: Math.max(0, Math.min(Number(item?.size || 0), MAX_ATTACHMENT_BYTES)),
    text: String(item?.text || "").replace(/```/g, "``\u200b`").slice(0, MAX_ATTACHMENT_TEXT),
    truncated: Boolean(item?.truncated) || String(item?.text || "").length > MAX_ATTACHMENT_TEXT,
  }));
}

module.exports = { ATTACHMENT_EXTENSIONS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TEXT, normalizeAttachmentList, parseAttachment };
