# Scholar Sidekick

An AI browser agent that finds relevant papers, books, and Stack Exchange
discussions for whatever you're studying, researching, or building.

## How it works

1. You open the extension while on a page (a course site, your notes, a doc)
   and type or confirm the topic.
2. The extension optionally grabs visible text from the current tab for context.
3. A small backend asks Claude to expand that into good search queries.
4. **Papers**: tries **real Google Scholar via [webcmd](https://github.com/agentrhq/webcmd)**
   first. Google actively blocks automated access to Scholar, so this is
   best-effort — if it's blocked, times out, or webcmd isn't installed on the
   machine running the backend, it **silently falls back to the Semantic
   Scholar API** (free, no key, no blocking risk). The user never sees a
   failure either way — `papersSource` in the response tells you which one
   actually served the results, shown live in the popup.
5. **Books** — **[Open Library](https://openlibrary.org)** first (free, no API key,
   effectively no rate limit — run by the Internet Archive), automatically falling
   back to Google Books if Open Library errors or is rate-limited.
   **Discussions** — Stack Exchange API (auto-picks the right site, e.g.
   math.stackexchange, cs.stackexchange, money.stackexchange, based on topic).
6. Claude ranks/filters everything and writes a one-line "why this matters"
   for each result.
7. The popup renders a clean digest.

**Requires `webcmd` installed globally** (`npm install -g @agentrhq/webcmd`) on
whatever machine runs `backend/`, with the `google-scholar` adapter installed
(`webcmd plugin install github:agentrhq/webcmd/google-scholar`). If it's not
installed, papers just come from Semantic Scholar every time — nothing breaks.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
npm start
```

Runs on `http://localhost:3000`.

### 2. Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the extension, click it on any page, type your topic, hit **Find resources**

## Demo tips

- Open it on a page related to your topic (a syllabus, a Wikipedia article,
  your own notes doc) and leave "Use context from the current page" checked —
  it noticeably improves relevance.
- **Papers via: Google Scholar (live)** vs **Papers via: Semantic Scholar (reason)**
  in the status line shows exactly what happened — e.g. "Semantic Scholar (Google
  Scholar blocked the request (bot-check/CAPTCHA))".
  
## Safety & reliability features

- **Sensitive-topic confirm gate**: before running any search, the backend classifies
  the topic. Sexual/porn topics and violent/true-crime subjects (e.g. a named serial
  killer) don't get blocked outright — the user sees a short warning and a "Show me
  anyway" button, and only proceeds if they choose to. **Incest is the one hard block**
  — no bypass offered. Gibberish/incomprehensible input is caught and the user is asked
  to rephrase. Ordinary academic topics (wars, genocide, market/industry analysis) are
  never interrupted — the gate is for topics whose core subject IS the sensitive
  material, not analytical treatment of a heavy subject.
- **Source status, not silence**: Semantic Scholar, Google Books, and Stack Exchange
  each report `ok`, `rate_limited`, or `error`. If a source is throttled or down, the
  popup shows a small warning banner for that section instead of just looking empty.
- **Load more**: each section has a "Show more" button that re-queries the backend
  with the titles already shown excluded, so you get a fresh batch instead of repeats.

## Extending it further (Scalability)

- Cache results in-memory so re-running the same topic is instant
- Adding a "save to reading list" button that persists via `chrome.storage`
- Swapping Google Books for Open Library if you want fuller metadata
- Add arXiv as a source for very recent preprints (free API, no key needed)
- Collaborating with API agents like **Claude** and **Gemini** for making API credits or tokens available to consumers at discounted prices

## Revenue Model
- 1. Freemium with search caps (the standard starting model)

Free tier: e.g. 10 searches/month — enough to try it, not enough for a whole semester
Paid tier: ~$4-8/month for unlimited searches, priced below Elicit/Consensus since you're targeting students on a budget, not funded researchers


2. Institutional/B2B — probably the stronger path

Sell to a university library, writing center, or a specific department (not individual students) as a bundled tool: "give every student in this course access"
One deal = hundreds of users at once, and universities already have budget lines for exactly this kind of tool (compare: library database subscriptions, Grammarly for Education, etc.)
Pricing here is typically an annual site license, not per-user — much more predictable revenue than chasing individual signups

3. Affiliate/referral on the books results

When a textbook is recommended, link through Amazon Associates or a similar program — small commission, doesn't cost the student anything extra, and you already have book recommendations built in

