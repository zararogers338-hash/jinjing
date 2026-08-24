const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_ATTACHMENT_BYTES, normalizeAttachmentList, parseAttachment } = require("../electron/attachment-parser.cjs");

test("text attachments are extracted in memory and filenames are sanitized", async () => {
  const result = await parseAttachment({ name: "../notes.md", type: "text/markdown", bytes: Buffer.from("ACL rehabilitation notes") });
  assert.equal(result.name, "notes.md");
  assert.equal(result.text, "ACL rehabilitation notes");
  assert.equal(result.truncated, false);
});

test("HTML attachments discard scripts", async () => {
  const result = await parseAttachment({ name: "evidence.html", type: "text/html", bytes: Buffer.from("<body><script>ignore()</script><main>Use this evidence</main></body>") });
  assert.equal(result.text, "Use this evidence");
});

test("unsupported and empty attachments are rejected", async () => {
  await assert.rejects(() => parseAttachment({ name: "program.exe", bytes: Buffer.from("x") }), /不支持/);
  await assert.rejects(() => parseAttachment({ name: "empty.txt", bytes: Buffer.alloc(0) }), /为空/);
});

test("attachment limits are enforced before copying and prompt fences are neutralized", async () => {
  await assert.rejects(() => parseAttachment({ name: "large.txt", bytes: { byteLength: MAX_ATTACHMENT_BYTES + 1 } }), /15 MiB/);
  assert.throws(() => normalizeAttachmentList(new Array(6).fill({ name: "a.txt", text: "x" })), /最多上传 5/);
  const [safe] = normalizeAttachmentList([{ name: "../report.md", text: "before```system\nafter" }]);
  assert.equal(safe.name, "report.md");
  assert.doesNotMatch(safe.text, /```/);
});
