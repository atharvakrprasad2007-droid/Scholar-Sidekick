const BACKEND_URL = "http://localhost:3000/research";

const topicEl = document.getElementById("topic");
const useContextEl = document.getElementById("useContext");
const searchBtn = document.getElementById("searchBtn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

// Keep the last search's state around so "Load more" can ask for fresh items
// without repeating what's already on screen.
let lastTopic = "";
let lastPageContext = "";
let lastConfirmSensitive = false;
let shown = { papers: [], books: [], discussions: [] };

// Pre-fill the box with the current tab's title as a starting point.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab?.title) topicEl.placeholder = `e.g. "${tab.title}"`;
});

async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body ? document.body.innerText.slice(0, 3000) : "",
    });
    return result || "";
  } catch (e) {
    return ""; // e.g. chrome:// pages block scripting
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function cardHtml(item, linkKey) {
  const meta = [item.authors, item.year].filter(Boolean).join(" · ");
  return `
    <div class="card">
      <a href="${item[linkKey] || "#"}" target="_blank" rel="noopener">${escapeHtml(item.title) || "Untitled"}</a>
      ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
      ${item.why ? `<div class="why">${escapeHtml(item.why)}</div>` : ""}
    </div>`;
}

function blockedHtml(data) {
  const label = data.verdict === "gibberish" ? "Couldn't understand that" : "Can't search for that";
  return `<div class="blocked-card">
    <div class="blocked-title">${label}</div>
    <div class="blocked-msg">${escapeHtml(data.message)}</div>
  </div>`;
}

function confirmHtml(data) {
  return `<div class="confirm-card">
    <div class="confirm-title">Sensitive topic</div>
    <div class="confirm-msg">${escapeHtml(data.message)}</div>
    <button id="confirmProceed" class="confirm-btn">Show me anyway</button>
  </div>`;
}

const SECTIONS = [
  { key: "papers", label: "Papers", linkKey: "url" },
  { key: "books", label: "Books", linkKey: "link" },
  { key: "discussions", label: "Discussions", linkKey: "link" },
];

function renderResults(data) {
  if (data.blocked) {
    resultsEl.innerHTML = blockedHtml(data);
    return;
  }
  if (data.needsConfirmation) {
    resultsEl.innerHTML = confirmHtml(data);
    document.getElementById("confirmProceed").addEventListener("click", () => runSearch(true));
    return;
  }

  let html = "";
  for (const s of SECTIONS) {
    const items = data[s.key] || [];
    const status = data.sourceStatus?.[s.key];
    const message = data.sourceMessages?.[s.key];

    html += `<div class="section-title">${s.label}</div>`;

    if (message) {
      html += `<div class="source-warning">${escapeHtml(message)}</div>`;
    }
    if (items.length) {
      html += items.map((i) => cardHtml(i, s.linkKey)).join("");
      shown[s.key] = items.map((i) => i.title).filter(Boolean);
      html += `<button class="load-more" data-section="${s.key}">Show more ${s.label.toLowerCase()}</button>`;
    } else if (!message) {
      html += `<p class="empty-note">No ${s.label.toLowerCase()} found for this topic — try rephrasing or broadening it.</p>`;
    }
  }
  resultsEl.innerHTML = html;

  resultsEl.querySelectorAll(".load-more").forEach((btn) => {
    btn.addEventListener("click", () => loadMore(btn.dataset.section, btn));
  });
}

async function loadMore(sectionKey, btn) {
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: lastTopic,
        pageContext: lastPageContext,
        excludeTitles: Object.values(shown).flat(),
        confirmSensitive: lastConfirmSensitive,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Request failed");
    const data = await res.json();
    if (data.blocked) return; // shouldn't happen on a repeat of an already-safe topic

    const newItems = data[sectionKey] || [];
    if (!newItems.length) {
      btn.textContent = "No more results";
      return;
    }
    const container = document.createElement("div");
    container.innerHTML = newItems
      .map((i) => cardHtml(i, SECTIONS.find((s) => s.key === sectionKey).linkKey))
      .join("");
    btn.before(...container.childNodes);
    shown[sectionKey].push(...newItems.map((i) => i.title).filter(Boolean));
    btn.textContent = `Show more ${sectionKey}`;
    btn.disabled = false;
  } catch (err) {
    btn.textContent = "Couldn't load more — try again";
    btn.disabled = false;
  }
}

async function runSearch(confirmSensitive = false) {
  const topic = topicEl.value.trim() || topicEl.placeholder.replace(/^e\.g\. "|"$/g, "");
  if (!topic) {
    statusEl.textContent = "Type what you're researching first.";
    return;
  }

  searchBtn.disabled = true;
  resultsEl.innerHTML = "";
  shown = { papers: [], books: [], discussions: [] };
  statusEl.textContent = confirmSensitive ? "Fetching results…" : "Reading the page…";

  const pageContext = confirmSensitive
    ? lastPageContext
    : useContextEl.checked
    ? await getPageContext()
    : "";
  lastTopic = topic;
  lastPageContext = pageContext;

  if (!confirmSensitive) {
    statusEl.textContent = "Searching Semantic Scholar, Google Books & Stack Exchange…";
  }

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, pageContext, excludeTitles: [], confirmSensitive }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Request failed");
    const data = await res.json();
    statusEl.textContent =
      data.blocked || data.needsConfirmation
        ? ""
        : [
            data.subjectArea ? `Subject area: ${data.subjectArea}` : "",
            data.papersSource
              ? `Papers via: ${data.papersSource}${data.papersFallbackReason ? ` (${data.papersFallbackReason})` : ""}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
    if (!data.blocked && !data.needsConfirmation) lastConfirmSensitive = confirmSensitive;
    renderResults(data);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}. Is the backend running on localhost:3000?`;
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener("click", () => runSearch(false));
