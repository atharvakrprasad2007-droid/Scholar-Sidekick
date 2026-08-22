// server.js — orchestrates the research agent pipeline
// 1. Takes a topic (+ optional page context) from the extension
// 2. Asks Claude to expand it into good search queries
// 3. Hits Semantic Scholar, Google Books, and Stack Exchange in parallel
// 4. Asks Claude to rank/filter + write a one-line "why this matters" for each
// 5. Returns a clean digest as JSON

import express from "express";
import cors from "cors";
import "dotenv/config";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6"; // fast + cheap enough for a hackathon demo

// ---------- Claude helper ----------
async function askClaude(prompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || "").join("\n");
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{") !== -1 && cleaned.indexOf("{") < (cleaned.indexOf("[") === -1 ? Infinity : cleaned.indexOf("["))
    ? cleaned.indexOf("{")
    : cleaned.indexOf("[");
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- Step 0: moderate the input before spending any API calls ----------
// Model: most sensitive topics get a CONFIRM step (user is warned and can choose to
// proceed) rather than an outright block. Incest stays a hard block. Gibberish asks
// for a clearer topic. Ordinary academic subjects — including historical wars,
// genocide, or true crime studied as forensic/legal case studies — should still be
// "safe" and never interrupt the user; the confirm step is for topics whose primary
// subject IS the sensitive material itself (explicit sexual content, graphic violence,
// or a named violent criminal / serial killer as the research subject).
async function moderateInput(topic) {
  const prompt = `Classify this research topic a student submitted to a study-help tool.

Topic: "${topic}"

Return ONLY a JSON object (no prose, no markdown fences):
{
  "verdict": "safe" | "confirm" | "blocked" | "gibberish",
  "category": "none" | "sexual" | "violence_true_crime" | "incest" | "gibberish",
  "message": "if not safe, a short (<20 word) neutral message describing what the topic touches on, for a confirmation prompt"
}

Rules:
- "safe": ordinary academic/course topics, INCLUDING serious historical subjects like
  wars, battles, or genocide, and general social/economic research (e.g. an industry's
  market size or growth trends) even if the industry itself is sexual in nature.
- "confirm"/"sexual": the topic's core subject is explicit sexual content or pornography
  itself (not just an industry/market analysis that happens to mention it).
- "confirm"/"violence_true_crime": the topic's core subject is a specific violent
  criminal, serial killer, or graphic/gratuitous violence — even if framed
  academically (e.g. "Ted Bundy", "school shooting details"). This is broader than
  "blocked" — it's just a heads-up, not a refusal.
- "blocked"/"incest": incest-themed content of any kind — always blocked outright,
  no confirmation offered.
- "gibberish": input that isn't a comprehensible topic (random characters, keyboard
  mashing, meaningless text).
When in doubt between "safe" and "confirm", prefer "safe" for topics that are clearly
academic/analytical (market analysis, policy, statistics) rather than about the
sensitive subject matter itself.`;
  const raw = await askClaude(prompt, 250);
  try {
    return extractJson(raw);
  } catch {
    // If the classifier itself fails to return clean JSON, fail open (treat as safe)
    // rather than blocking a legitimate request due to our own parsing bug.
    return { verdict: "safe", category: "none", message: "" };
  }
}

// ---------- Step 1: expand the topic into search queries ----------
async function expandQueries(topic, pageContext) {
  const prompt = `A student is researching the following topic for a course/project/assignment.

Topic: "${topic}"
${pageContext ? `Extra context from the page they're currently on:\n"""${pageContext.slice(0, 1500)}"""` : ""}

Return ONLY a JSON object (no prose, no markdown fences) with:
{
  "paper_queries": [2-3 short precise search queries for an academic paper search engine],
  "book_query": "one broad search query for finding relevant textbooks",
  "discussion_queries": [1-2 short queries for finding relevant Stack Exchange discussions],
  "subject_area": "one or two words, e.g. 'machine learning', 'organic chemistry', used to pick the right Stack Exchange site"
}`;
  const raw = await askClaude(prompt, 400);
  return extractJson(raw);
}

// ---------- Step 2: fetch from free APIs in parallel ----------
// Each source returns { status: "ok"|"rate_limited"|"error", items: [...] }
// so the frontend can tell "genuinely no results" apart from "this source failed".
function statusFromResponse(res) {
  if (res.ok) return "ok";
  if (res.status === 429) return "rate_limited";
  return "error";
}

// ---------- Google Scholar via webcmd (real Scholar access, best-effort) ----------
// Google actively blocks automated access to Scholar, so this is inherently
// unreliable — sometimes it works, sometimes Google's bot-check blocks it. We treat
// any failure (blocked, timeout, webcmd not installed) as a signal to fall back to
// Semantic Scholar — but we track WHY it failed so the demo can show the specific
// reason instead of just "it didn't work".
const WEBCMD_TIMEOUT_MS = 20000;

const FALLBACK_REASONS = {
  blocked: "Google Scholar blocked the request (bot-check/CAPTCHA)",
  timeout: "Google Scholar request timed out",
  not_installed: "webcmd isn't installed on this machine",
  no_papers: "webcmd reached Scholar but found no usable results",
  error: "Google Scholar fetch failed",
};

async function fetchGoogleScholarRaw(query) {
  const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&scisbd=1`;
  const cmd = `webcmd web fetch --url "${url}" -f json`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: WEBCMD_TIMEOUT_MS });
    const data = JSON.parse(stdout);
    // Google's bot-check redirects to google.com/sorry — treat that as blocked.
    const blocked =
      data.status === 302 ||
      (typeof data.content === "string" && data.content.toLowerCase().includes("google.com/sorry"));
    if (blocked) return { content: null, reason: "blocked" };
    if (!data.content) return { content: null, reason: "error" };
    return { content: data.content, reason: null };
  } catch (err) {
    // execAsync throws on: timeout (err.killed === true), command not found
    // (err.code === 127 or "not recognized" on Windows), or any non-zero exit.
    if (err.killed) return { content: null, reason: "timeout" };
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("not recognized") || msg.includes("command not found") || err.code === 127) {
      return { content: null, reason: "not_installed" };
    }
    return { content: null, reason: "error" };
  }
}

async function parseScholarContent(rawContent, topic) {
  const prompt = `Extract real academic papers from this Google Scholar page content, relevant to: "${topic}"

Content:
"""${rawContent.slice(0, 6000)}"""

Return ONLY a JSON array (no prose, no markdown fences). Each item:
{"title":"", "authors":"", "year":"", "url":""}
If the content doesn't contain real paper listings (e.g. it's a block/error page), return [].`;
  const raw = await askClaude(prompt, 800);
  try {
    const parsed = extractJson(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function searchGoogleScholarViaWebcmd(query, topic) {
  const { content, reason } = await fetchGoogleScholarRaw(query);
  if (!content) return { status: "unavailable", items: [], reason };
  const papers = await parseScholarContent(content, topic);
  if (!papers.length) return { status: "unavailable", items: [], reason: "no_papers" };
  return { status: "ok", items: papers, reason: null };
}

// ---------- Semantic Scholar (reliable fallback for papers) ----------
async function searchSemanticScholar(query, limit = 5) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    query
  )}&limit=${limit}&fields=title,abstract,url,year,authors.name,citationCount`;
  try {
    const res = await fetch(url);
    const status = statusFromResponse(res);
    if (status !== "ok") return { status, items: [] };
    const data = await res.json();
    return {
      status: "ok",
      items: (data.data || []).map((p) => ({
        title: p.title,
        authors: (p.authors || []).map((a) => a.name).slice(0, 3).join(", "),
        year: p.year,
        citationCount: p.citationCount,
        url: p.url,
        abstract: p.abstract,
      })),
    };
  } catch {
    return { status: "error", items: [] };
  }
}

// ---------- Books: Open Library first (no key, no rate limit), Google Books as fallback ----------
async function searchOpenLibrary(query, limit = 5) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=title,author_name,first_publish_year,key`;
  try {
    const res = await fetch(url);
    const status = statusFromResponse(res);
    if (status !== "ok") return { status, items: [] };
    const data = await res.json();
    return {
      status: "ok",
      items: (data.docs || [])
        .filter((b) => b.title)
        .map((b) => ({
          title: b.title,
          authors: (b.author_name || []).slice(0, 3).join(", "),
          year: b.first_publish_year ? String(b.first_publish_year) : undefined,
          link: b.key ? `https://openlibrary.org${b.key}` : undefined,
        })),
    };
  } catch {
    return { status: "error", items: [] };
  }
}

async function searchGoogleBooks(query, limit = 5) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
    query
  )}&maxResults=${limit}`;
  try {
    const res = await fetch(url);
    const status = statusFromResponse(res);
    if (status !== "ok") return { status, items: [] };
    const data = await res.json();
    return {
      status: "ok",
      items: (data.items || []).map((b) => ({
        title: b.volumeInfo?.title,
        authors: (b.volumeInfo?.authors || []).join(", "),
        year: b.volumeInfo?.publishedDate?.slice(0, 4),
        description: b.volumeInfo?.description,
        link: b.volumeInfo?.infoLink,
      })),
    };
  } catch {
    return { status: "error", items: [] };
  }
}

// Try Open Library first; only fall back to Google Books if it genuinely fails
// (rate-limited/error) or returns nothing. Books never surface which source served
// them since both are equally legitimate — unlike the Scholar/webcmd case, there's
// no "live vs fallback" story worth telling here.
async function searchBooks(query, limit = 5) {
  const primary = await searchOpenLibrary(query, limit);
  if (primary.status === "ok" && primary.items.length > 0) return primary;
  if (primary.status === "ok") return primary; // genuinely no results, not a failure
  return searchGoogleBooks(query, limit); // Open Library errored/rate-limited — fall back
}

// Map a rough subject area to a relevant Stack Exchange site.
// Falls back to stackoverflow for anything CS/programming-flavored.
const SE_SITE_MAP = [
  { keywords: ["math", "calculus", "algebra", "geometry"], site: "math" },
  { keywords: ["physics"], site: "physics" },
  { keywords: ["chemistry", "chem"], site: "chemistry" },
  { keywords: ["biology", "bio"], site: "biology" },
  { keywords: ["stat", "data science", "machine learning", "ml", "ai"], site: "stats" },
  { keywords: ["cs", "computer science", "algorithm", "programming", "software"], site: "cs" },
  { keywords: ["economics", "econ", "finance", "business", "management", "marketing", "sports"], site: "money" },
  { keywords: ["philosophy"], site: "philosophy" },
  { keywords: ["history"], site: "history" },
  { keywords: ["law", "legal"], site: "law" },
  { keywords: ["psychology"], site: "psychology" },
];

// Default fallback for anything unmapped: academia.stackexchange is a much better
// general-purpose bet than stackoverflow for non-programming topics.
function pickSESite(subjectArea = "") {
  const s = subjectArea.toLowerCase();
  const match = SE_SITE_MAP.find((m) => m.keywords.some((k) => s.includes(k)));
  if (match) return match.site;
  return s.includes("program") || s.includes("code") || s.includes("software")
    ? "stackoverflow"
    : "academia";
}

async function searchStackExchange(query, site, limit = 5) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(
    query
  )}&site=${site}&filter=default&pagesize=${limit}`;
  try {
    const res = await fetch(url);
    const status = statusFromResponse(res);
    if (status !== "ok") return { status, items: [] };
    const data = await res.json();
    // Stack Exchange also signals throttling inside a 200 response via backoff/error_id
    if (data.error_id) return { status: "rate_limited", items: [] };
    return {
      status: "ok",
      items: (data.items || []).map((q) => ({
        title: q.title,
        link: q.link,
        score: q.score,
        answers: q.answer_count,
        isAnswered: q.is_answered,
      })),
    };
  } catch {
    return { status: "error", items: [] };
  }
}

// ---------- Step 3: rank + annotate with Claude ----------
// excludeTitles lets "load more" ask for a fresh batch that skips what's already shown.
async function rankResults(topic, papers, books, discussions, excludeTitles = []) {
  const prompt = `A student is researching: "${topic}"

Here are raw search results (JSON). Pick the best ones and write a ONE-SENTENCE "why it matters" for each, tailored to the topic. Drop anything irrelevant or low quality. Order each list by relevance.
${excludeTitles.length ? `\nThe student already saw these titles — DO NOT include them again, pick different ones:\n${JSON.stringify(excludeTitles)}` : ""}

PAPERS: ${JSON.stringify(papers).slice(0, 6000)}
BOOKS: ${JSON.stringify(books).slice(0, 3000)}
DISCUSSIONS: ${JSON.stringify(discussions).slice(0, 3000)}

Return ONLY a JSON object (no prose, no markdown fences):
{
  "papers": [{"title":"", "authors":"", "year":"", "url":"", "why":""}],
  "books": [{"title":"", "authors":"", "year":"", "link":"", "why":""}],
  "discussions": [{"title":"", "link":"", "why":""}]
}
Limit to at most 4 items per list.`;
  const raw = await askClaude(prompt, 1500);
  return extractJson(raw);
}

// Combine several {status, items} results from parallel queries into one.
// "ok" if at least one succeeded with items; otherwise surface the failure reason.
function mergeSourceResults(results) {
  const items = results.flatMap((r) => r.items);
  if (items.length > 0) return { status: "ok", items };
  if (results.some((r) => r.status === "rate_limited")) return { status: "rate_limited", items: [] };
  if (results.some((r) => r.status === "error")) return { status: "error", items: [] };
  return { status: "ok", items: [] }; // genuinely no results, not a failure
}

const SOURCE_MESSAGES = {
  rate_limited: "This source is rate-limited right now — try again in a minute.",
  error: "This source is temporarily unavailable.",
};

// ---------- Route ----------
app.post("/research", async (req, res) => {
  try {
    const { topic, pageContext, excludeTitles, confirmSensitive } = req.body;
    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: "topic is required" });
    }

    // Gate: moderate before spending any search/LLM calls on unsafe or nonsense input.
    const moderation = await moderateInput(topic);

    if (moderation.verdict === "blocked") {
      return res.json({
        blocked: true,
        category: moderation.category,
        message: moderation.message || "This topic can't be processed by this tool.",
      });
    }
    if (moderation.verdict === "gibberish") {
      return res.json({
        blocked: true,
        verdict: "gibberish",
        category: "gibberish",
        message: moderation.message || "That doesn't look like a readable topic — could you rephrase it?",
      });
    }
    if (moderation.verdict === "confirm" && !confirmSensitive) {
      return res.json({
        needsConfirmation: true,
        category: moderation.category,
        message: moderation.message || "This topic touches on sensitive content.",
      });
    }
    // verdict === "safe", or "confirm" with confirmSensitive === true: proceed.

    const expanded = await expandQueries(topic, pageContext);
    const site = pickSESite(expanded.subject_area);
    const limit = excludeTitles?.length ? 8 : 5; // cast a wider net on "load more"

    // Papers: try real Google Scholar via webcmd first. It's genuinely Scholar data
    // when it works, but Google actively blocks automated access, so this is
    // best-effort — any failure falls back to Semantic Scholar without the user
    // ever seeing an error.
    const scholarQuery = (expanded.paper_queries && expanded.paper_queries[0]) || topic;
    const webcmdResult = await searchGoogleScholarViaWebcmd(scholarQuery, topic);

    const [paperResult, bookResult, discussionResult] = await Promise.all([
      webcmdResult.status === "ok"
        ? Promise.resolve({ status: "ok", items: webcmdResult.items })
        : Promise.all(
            (expanded.paper_queries || [topic]).map((q) => searchSemanticScholar(q, limit))
          ).then(mergeSourceResults),
      searchBooks(expanded.book_query || topic, limit),
      Promise.all(
        (expanded.discussion_queries || [topic]).map((q) => searchStackExchange(q, site, limit))
      ).then(mergeSourceResults),
    ]);
    // searchBooks doesn't need merging (single call), just normalize its shape
    const booksNormalized = Array.isArray(bookResult) ? { status: "ok", items: bookResult } : bookResult;

    const digest = await rankResults(
      topic,
      paperResult.items,
      booksNormalized.items,
      discussionResult.items,
      excludeTitles || []
    );

    res.json({
      topic,
      subjectArea: expanded.subject_area,
      ...digest,
      papersSource: webcmdResult.status === "ok" ? "Google Scholar (live)" : "Semantic Scholar",
      papersFallbackReason:
        webcmdResult.status === "ok" ? null : FALLBACK_REASONS[webcmdResult.reason] || FALLBACK_REASONS.error,
      sourceStatus: {
        papers: paperResult.status,
        books: booksNormalized.status,
        discussions: discussionResult.status,
      },
      sourceMessages: {
        papers: SOURCE_MESSAGES[paperResult.status],
        books: SOURCE_MESSAGES[booksNormalized.status],
        discussions: SOURCE_MESSAGES[discussionResult.status],
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Research agent backend running on http://localhost:${PORT}`));
