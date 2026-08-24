const assert = require("node:assert/strict");
const test = require("node:test");
const { assertPublicUrl, extractPage, isPrivateAddress, parseSearchHtml } = require("../electron/web-search.cjs");

test("standalone web adapter parses public search results", () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpaper">Paper title</a><div class="result__snippet">Useful evidence.</div></div>`;
  assert.deepEqual(parseSearchHtml(html), [{ title: "Paper title", url: "https://example.com/paper", snippet: "Useful evidence." }]);
});

test("web page extraction removes executable and navigation text", () => {
  const page = extractPage("<html><head><title>Guide</title><script>secret()</script></head><body><nav>menu</nav><main>Clinical recommendation</main></body></html>", "https://example.com", "text/html");
  assert.equal(page.title, "Guide");
  assert.equal(page.text, "Clinical recommendation");
});

test("private network addresses are blocked", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/private"), /blocked/);
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /HTTP/);
});

test("web research budget tells the agent to stop and synthesize", async () => {
  const { WebSearchService } = require("../electron/web-search.cjs");
  const service = new WebSearchService();
  service.resetBudget(1);
  service.search = async () => [];
  await service.run({ search_query: [{ q: "first" }] });
  const result = await service.run({ search_query: [{ q: "second" }] });
  assert.match(result.output, /produce the final answer now/i);
});
