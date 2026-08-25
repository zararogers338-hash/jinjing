const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HistoryStore } = require("../electron/history-store.cjs");

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jinjing-history-"));
  let counter = 0;
  const store = new HistoryStore(path.join(directory, "chat-history.json"), {
    now: () => `2026-08-25T00:00:0${counter++}.000Z`,
    idFactory: () => `session-${String(counter++).padStart(8, "0")}`,
  });
  try { run(store, directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("chat sessions persist and reload in updated order", () => withStore((store, directory) => {
  const first = store.create();
  store.save({ id: first.id, messages: [{ id: "message-00000001", role: "user", text: "ACL 重建术后如何重返运动？", time: "10:20", pending: true }] });
  const second = store.create();
  store.save({ id: second.id, messages: [{ id: "message-00000002", role: "user", text: "肩袖损伤康复", time: "10:21" }] });
  const reloaded = new HistoryStore(path.join(directory, "chat-history.json"));
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.list()[0].title, "肩袖损伤康复");
  assert.equal(reloaded.get(first.id).messages[0].pending, false);
}));

test("history sanitizes messages, evidence URLs, and malformed records", () => withStore((store) => {
  const session = store.save({
    id: "valid-session-0001",
    messages: [
      { id: "valid-message-0001", role: "system", text: "discard" },
      { id: "valid-message-0002", role: "assistant", text: `answer\u0000`, error: true },
    ],
    evidence: { results: [{ pmid: "1", title: "Paper", pubmed_url: "http://localhost/private" }, { pmid: "2", title: "Public", pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/2/" }] },
  });
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].text, "answer");
  assert.equal(session.evidence.results[0].pubmed_url, "");
  assert.equal(session.evidence.results[1].pubmed_url, "https://pubmed.ncbi.nlm.nih.gov/2/");
}));

test("corrupt or oversized history fails closed", () => withStore((store) => {
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, "not json", "utf8");
  assert.deepEqual(store.list(), []);
}));

test("history supports an encrypted-at-rest codec boundary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jinjing-history-codec-"));
  const file = path.join(directory, "chat-history.bin");
  const options = {
    encode: (value) => Buffer.from(value, "utf8").reverse(),
    decode: (value) => Buffer.from(value).reverse().toString("utf8"),
  };
  try {
    const store = new HistoryStore(file, options);
    const session = store.create();
    store.save({ id: session.id, messages: [{ id: "message-00000003", role: "user", text: "encrypted history", time: "10:22" }] });
    assert.doesNotMatch(fs.readFileSync(file).toString("utf8"), /encrypted history/);
    assert.equal(new HistoryStore(file, options).get(session.id).messages[0].text, "encrypted history");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
