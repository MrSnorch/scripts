const pageConfig = (() => {
  const { dataset } = document.body;
  return {
    ownerName: dataset.ownerName || dataset.githubUser || "Author",
    user: dataset.githubUser || "MrSnorch",
    repo: dataset.githubRepo || "scripts",
    scriptsPath: dataset.scriptsPath || "files",
  };
})();

const state = {
  records: [],
  query: "",
};

const elements = {
  repoBrand: document.getElementById("repoBrand"),
  repoLink: document.getElementById("repoLink"),
  publishPath: document.getElementById("publishPath"),
  search: document.getElementById("scriptSearch"),
  reloadButton: document.getElementById("reloadButton"),
  grid: document.getElementById("scriptGrid"),
  resultSummary: document.getElementById("resultSummary"),
  statusNote: document.getElementById("statusNote"),
  scriptCount: document.getElementById("scriptCount"),
  toast: document.getElementById("toast"),
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
let toastTimer = null;

init();

function init() {
  const repoUrl = `https://github.com/${pageConfig.user}/${pageConfig.repo}`;
  document.title = `${pageConfig.ownerName} Scripts`;
  elements.repoBrand.textContent = `${pageConfig.ownerName} Scripts`;
  elements.repoLink.href = repoUrl;
  elements.publishPath.textContent = `/${pageConfig.scriptsPath}`;

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderCatalog();
  });

  elements.reloadButton.addEventListener("click", () => {
    loadCatalog({ forceReload: true });
  });

  elements.grid.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-url]");
    if (!button) return;

    const url = button.getAttribute("data-copy-url");
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      showToast("Raw URL copied.");
    } catch (error) {
      showToast("Could not copy the raw URL.");
    }
  });

  renderLoadingState();
  loadCatalog();
}

async function loadCatalog({ forceReload = false } = {}) {
  elements.reloadButton.disabled = true;
  elements.resultSummary.textContent = "Loading scripts from GitHub...";
  elements.statusNote.textContent = "Reading repository contents and userscript metadata.";
  renderLoadingState();

  try {
    const contentsUrl = `https://api.github.com/repos/${pageConfig.user}/${pageConfig.repo}/contents/${pageConfig.scriptsPath}`;
    const response = await fetch(contentsUrl, {
      cache: forceReload ? "reload" : "default",
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      throw new Error(getGitHubErrorMessage(response.status));
    }

    const entries = await response.json();
    const files = Array.isArray(entries)
      ? entries.filter((entry) => entry.type === "file" && entry.name.endsWith(".user.js"))
      : [];

    const records = await Promise.all(files.map(loadScriptRecord));
    state.records = records.sort((left, right) => collator.compare(left.name, right.name));
    updateHeaderStats();
    renderCatalog();
  } catch (error) {
    state.records = [];
    updateHeaderStats();
    renderErrorState(error instanceof Error ? error.message : "Catalog could not be loaded.");
  } finally {
    elements.reloadButton.disabled = false;
  }
}

async function loadScriptRecord(file) {
  try {
    const sourceResponse = await fetch(file.download_url, { cache: "no-store" });
    if (!sourceResponse.ok) {
      throw new Error("Metadata unavailable");
    }

    const source = await sourceResponse.text();
    const meta = parseUserscriptMetadata(source);
    const fallback = parseFilename(file.name);

    return {
      name: meta.name || fallback.name,
      version: meta.version || fallback.version || "Unversioned",
      description: meta.description || "No description provided.",
      targets: getTargets(meta.match, meta.include),
      grants: unique(meta.grant),
      installUrl: meta.downloadURL || file.download_url,
      rawUrl: file.download_url,
      sourceUrl: file.html_url,
      fileName: file.name,
      lines: source.split(/\r?\n/).length,
      hasMetadata: true,
    };
  } catch (error) {
    const fallback = parseFilename(file.name);
    return {
      name: fallback.name,
      version: fallback.version || "Unknown",
      description: "Metadata could not be read from this file.",
      targets: [],
      grants: [],
      installUrl: file.download_url,
      rawUrl: file.download_url,
      sourceUrl: file.html_url,
      fileName: file.name,
      lines: null,
      hasMetadata: false,
    };
  }
}

function renderCatalog() {
  if (!state.records.length) {
    elements.resultSummary.textContent = "No scripts found.";
    elements.statusNote.textContent = `Add .user.js files to /${pageConfig.scriptsPath} and reload the page.`;
    renderEmptyState("No scripts published yet", `Nothing was found in /${pageConfig.scriptsPath}.`);
    return;
  }

  const visible = state.records.filter((record) => matchesQuery(record, state.query));
  elements.grid.innerHTML = "";

  if (!visible.length) {
    elements.resultSummary.textContent = `0 results out of ${state.records.length}.`;
    elements.statusNote.textContent = "Search checks the script name, description, target, version, and file name.";
    renderEmptyState("No matching scripts", "Try a different search term.");
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((record) => {
    fragment.appendChild(buildScriptCard(record));
  });

  elements.grid.appendChild(fragment);
  elements.resultSummary.textContent = `Showing ${visible.length} of ${state.records.length} scripts.`;
  elements.statusNote.textContent = "Install links open the raw GitHub file. Source links open the repository page.";
}

function buildScriptCard(record) {
  const article = document.createElement("article");
  article.className = "script-card";

  const targetText = record.targets.length
    ? shortenTargets(record.targets)
    : "Target metadata missing";

  const metaParts = [
    record.lines ? `${formatNumber(record.lines)} lines` : "Lines unavailable",
    `Grant: ${record.grants[0] || "none"}`,
  ];

  article.innerHTML = `
    <div class="script-card__head">
      <div>
        <h2>${escapeHtml(record.name)}</h2>
        <p class="script-card__file">${escapeHtml(record.fileName)}</p>
      </div>
      <span class="script-card__version">v${escapeHtml(record.version)}</span>
    </div>

    <p class="script-card__description">${escapeHtml(record.description)}</p>
    <p class="script-card__targets">${escapeHtml(targetText)}</p>

    <div class="script-card__meta">
      ${metaParts.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join("")}
      ${record.hasMetadata ? "" : '<span class="badge badge--warning">Fallback</span>'}
    </div>

    <div class="script-card__actions">
      <a class="button button--primary" href="${escapeAttribute(record.installUrl)}" target="_blank" rel="noreferrer">Install</a>
      <a class="button button--secondary" href="${escapeAttribute(record.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>
      <button class="button button--ghost" type="button" data-copy-url="${escapeAttribute(record.rawUrl)}">Copy raw URL</button>
    </div>
  `;

  return article;
}

function renderLoadingState() {
  elements.grid.innerHTML = "";

  for (let index = 0; index < 3; index += 1) {
    const card = document.createElement("article");
    card.className = "script-card skeleton";
    card.innerHTML = `
      <div class="skeleton__line skeleton__line--title"></div>
      <div class="skeleton__line"></div>
      <div class="skeleton__line skeleton__line--short"></div>
      <div class="skeleton__line"></div>
    `;
    elements.grid.appendChild(card);
  }
}

function renderEmptyState(title, text) {
  const box = document.createElement("div");
  box.className = "empty-state";
  box.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(text)}</p>
  `;
  elements.grid.replaceChildren(box);
}

function renderErrorState(message) {
  const box = document.createElement("div");
  box.className = "error-state";
  box.innerHTML = `
    <h3>Catalog unavailable</h3>
    <p>${escapeHtml(message)}</p>
  `;

  elements.grid.replaceChildren(box);
  elements.resultSummary.textContent = "Could not load the catalog.";
  elements.statusNote.textContent = "Check the repository name, folder path, or GitHub API limits.";
}

function updateHeaderStats() {
  const count = state.records.length;
  elements.scriptCount.textContent = `${formatNumber(count)} ${count === 1 ? "script" : "scripts"}`;
}

function parseUserscriptMetadata(source) {
  const meta = { match: [], include: [], grant: [] };
  const blockMatch = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);

  if (!blockMatch) {
    return meta;
  }

  blockMatch[1]
    .split(/\r?\n/)
    .forEach((line) => {
      const lineMatch = line.match(/\/\/\s*@(\S+)\s+(.+)/);
      if (!lineMatch) return;

      const [, key, rawValue] = lineMatch;
      const value = rawValue.trim();

      if (key === "match" || key === "include" || key === "grant") {
        meta[key].push(value);
        return;
      }

      meta[key] = value;
    });

  return meta;
}

function parseFilename(fileName) {
  const stem = fileName.replace(/\.user\.js$/i, "");
  const match = stem.match(/^(.*?)-(\d+(?:\.\d+)+)$/);

  if (!match) {
    return {
      name: stem.replace(/[-_]+/g, " ").trim(),
      version: "",
    };
  }

  return {
    name: match[1].replace(/[-_]+/g, " ").trim(),
    version: match[2],
  };
}

function getTargets(matchRules = [], includeRules = []) {
  const rules = unique([...(matchRules || []), ...(includeRules || [])]);
  return unique(rules.map(extractTarget).filter(Boolean));
}

function extractTarget(rule) {
  if (!rule) return "";
  if (rule === "<all_urls>") return "All URLs";
  if (rule.startsWith("file://")) return "Local files";

  const host = rule.replace(/^[a-z*]+:\/\//i, "").split("/")[0].trim();
  if (!host || host === "*") return "Any host";
  return host;
}

function shortenTargets(targets) {
  const visible = targets.slice(0, 3);
  const extra = targets.length - visible.length;
  return extra > 0 ? `${visible.join(", ")} +${extra} more` : visible.join(", ");
}

function matchesQuery(record, query) {
  if (!query) return true;

  const haystack = [
    record.name,
    record.description,
    record.version,
    record.fileName,
    ...record.targets,
    ...record.grants,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 1800);
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function getGitHubErrorMessage(status) {
  if (status === 403) return "GitHub API rate limit reached. Try again later.";
  if (status === 404) return "Repository or publish folder was not found.";
  return `GitHub returned status ${status}.`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
