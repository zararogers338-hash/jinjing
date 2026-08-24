const dns = require("node:dns").promises;
const net = require("node:net");
const { load } = require("cheerio");

const USER_AGENT = "Jinjing/0.1 (+local Codex research client)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_TEXT = 14000;

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(value)) {
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  return true;
}

async function assertPublicUrl(input) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only public HTTP(S) pages are supported");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw new Error("Local network destinations are blocked");
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error("Private network destinations are blocked");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("Private or unresolved network destination is blocked");
  return url;
}

async function publicFetch(input, options = {}) {
  let url = await assertPublicUrl(input);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await fetch(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", ...(options.headers || {}) },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await assertPublicUrl(new URL(response.headers.get("location"), url).toString());
      continue;
    }
    return { response, url };
  }
  throw new Error("Too many redirects");
}

async function boundedText(response, maxBytes = MAX_PAGE_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function unwrapDuckDuckGoUrl(href) {
  if (!href) return "";
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return "";
  }
}

function parseSearchHtml(html, limit = 6) {
  const $ = load(html);
  const results = [];
  $(".result").each((_index, element) => {
    if (results.length >= limit) return false;
    const anchor = $(element).find(".result__a").first();
    const url = unwrapDuckDuckGoUrl(anchor.attr("href"));
    const title = compactText(anchor.text());
    const snippet = compactText($(element).find(".result__snippet").first().text());
    if (/^https?:\/\//i.test(url) && title) results.push({ title, url, snippet });
    return undefined;
  });
  return results;
}

function extractPage(html, url, contentType) {
  if (!/html|xhtml/i.test(contentType || "")) {
    return { title: new URL(url).hostname, text: compactText(html).slice(0, MAX_PAGE_TEXT) };
  }
  const $ = load(html);
  $("script,style,noscript,svg,canvas,form,nav,footer,aside").remove();
  const title = compactText($("title").first().text()) || new URL(url).hostname;
  const main = $("article,main,[role='main']").first();
  const text = compactText((main.length ? main : $("body")).text()).slice(0, MAX_PAGE_TEXT);
  return { title, text };
}

class WebSearchService {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.refs = new Map();
    this.refCounter = 0;
    this.requestCount = 0;
    this.maxRequests = 10;
  }

  resetBudget(maxRequests = 10) {
    this.requestCount = 0;
    this.maxRequests = Math.max(1, Math.min(Number(maxRequests || 10), 20));
    this.refs.clear();
  }

  async search(query, limit = 6) {
    const term = compactText(query).slice(0, 500);
    if (!term) return [];
    const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}`;
    const { response } = await publicFetch(target, { timeoutMs: 18000 });
    if (!response.ok) throw new Error(`Search backend returned ${response.status}`);
    const parsed = parseSearchHtml(await boundedText(response), limit);
    return parsed.map((item) => {
      const ref_id = `web${++this.refCounter}`;
      this.refs.set(ref_id, item.url);
      return { type: "text_result", ref_id, ...item };
    });
  }

  resolveTarget(value) {
    return this.refs.get(value) || value;
  }

  async open(value) {
    const target = this.resolveTarget(value);
    const { response, url } = await publicFetch(target);
    if (!response.ok) throw new Error(`Page returned ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (/application\/pdf/i.test(contentType)) return { title: "PDF document", url: url.toString(), text: "PDF page detected. Open the cited URL for the full document." };
    return { ...(extractPage(await boundedText(response), url.toString(), contentType)), url: url.toString() };
  }

  async run(commands = {}) {
    this.requestCount += 1;
    if (this.requestCount > this.maxRequests) {
      this.onLog("web", `research budget reached (${this.maxRequests})`);
      return {
        encrypted_output: "",
        output: "WEB RESEARCH BUDGET REACHED. Do not call web.run again in this turn. Use the sources and evidence already collected, state remaining uncertainty, and produce the final answer now.",
        results: [],
      };
    }
    const output = [];
    const results = [];
    for (const item of (commands.search_query || []).slice(0, 4)) {
      const query = compactText(item?.q);
      if (!query) continue;
      try {
        const found = await this.search(query, 6);
        results.push(...found);
        output.push(`SEARCH: ${query}`);
        found.forEach((result, index) => output.push(`${index + 1}. [${result.ref_id}] ${result.title}\n${result.url}\n${result.snippet}`));
      } catch (error) {
        output.push(`SEARCH ERROR: ${query}\n${error.message}`);
      }
    }
    for (const item of (commands.open || []).slice(0, 4)) {
      const ref = item?.ref_id;
      if (!ref) continue;
      try {
        const page = await this.open(ref);
        output.push(`OPEN: ${page.title}\n${page.url}\n${page.text}`);
      } catch (error) {
        output.push(`OPEN ERROR: ${ref}\n${error.message}. Try another search result or cite the search result conservatively.`);
      }
    }
    for (const item of (commands.find || []).slice(0, 4)) {
      if (!item?.ref_id || !item?.pattern) continue;
      const pattern = compactText(item.pattern);
      try {
        const page = await this.open(item.ref_id);
        const lower = page.text.toLowerCase();
        const index = lower.indexOf(pattern.toLowerCase());
        const excerpt = index < 0 ? "Pattern not found." : page.text.slice(Math.max(0, index - 500), Math.min(page.text.length, index + pattern.length + 1000));
        output.push(`FIND: ${pattern}\n${page.url}\n${excerpt}`);
      } catch (error) {
        output.push(`FIND ERROR: ${pattern}\n${error.message}`);
      }
    }
    for (const item of (commands.time || []).slice(0, 8)) {
      const offset = compactText(item?.utc_offset);
      const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
      if (!match) continue;
      const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1);
      output.push(`TIME ${offset}: ${new Date(Date.now() + minutes * 60000).toISOString().replace("Z", offset)}`);
    }
    if (!output.length) output.push("This local standalone web adapter currently supports search_query, open, find, and time commands.");
    this.onLog("web", `completed ${Object.keys(commands).join(", ") || "empty"} command (${this.requestCount}/${this.maxRequests})`);
    return { encrypted_output: "", output: output.join("\n\n").slice(0, 50000), results };
  }
}

module.exports = { WebSearchService, assertPublicUrl, compactText, extractPage, isPrivateAddress, parseSearchHtml, publicFetch };
