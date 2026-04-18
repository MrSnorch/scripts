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
  loading: false,
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
  targetCount: document.getElementById("targetCount"),
  toast: document.getElementById("toast"),
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
let toastTimer = null;

init();

function init() {
  const repoUrl = `https://github.com/${pageConfig.user}/${pageConfig.repo}`;
  document.title = `${pageConfig.ownerName} Scripts`;
  elements.repoBrand.href = repoUrl;
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
      showToast("Raw URL copied to clipboard.");
    } catch (error) {
      showToast("Clipboard access failed. You can copy the raw URL manually.");
    }
  });

  renderLoadingState();
  loadCatalog();
}

async function loadCatalog({ forceReload = false } = {}) {
  state.loading = true;
  elements.reloadButton.disabled = true;
  elements.resultSummary.textContent = "Loading scripts from GitHub...";
  elements.statusNote.textContent = "Reading repository contents and parsing userscript metadata.";
  renderLoadingState();

  try {
    const contentsUrl = `https://api.github.com/repos/${pageConfig.user}/${pageConfig.repo}/contents/${pageConfig.scriptsPath}`;
    const response = await fetch(contentsUrl, {
      cache: forceReload ? "reload" : "default",
      headers: {
        Accept: "application/vnd.github+json",
      },
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
    updateStats(state.records);
    renderCatalog();
  } catch (error) {
    state.records = [];
    updateStats([]);
    renderErrorState(error instanceof Error ? error.message : "Something went wrong while loading the catalog.");
  } finally {
    state.loading = false;
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
    const targets = getTargets(meta.match, meta.include);
    const grantList = unique(meta.grant).filter(Boolean);

    return {
      name: meta.name || fallback.name,
      version: meta.version || fallback.version || "Unversioned",
      description: meta.description || "No description provided yet.",
      namespace: meta.namespace || "No namespace",
      matches: unique([...(meta.match || []), ...(meta.include || [])]),
      targets,
      grants: grantList.length ? grantList : ["none"],
      installUrl: meta.downloadURL || file.download_url,
      rawUrl: file.download_url,
      sourceUrl: file.html_url || `https://github.com/${pageConfig.user}/${pageConfig.repo}/blob/main/${file.path}`,
      lines: source.split(/\r?\n/).length,
      fileName: file.name,
      path: file.path,
      hasMetadata: true,
    };
  } catch (error) {
    const fallback = parseFilename(file.name);
    return {
      name: fallback.name,
      version: fallback.version || "Unknown",
      description: "Metadata could not be loaded from this script yet.",
      namespace: "Unknown",
      matches: [],
      targets: [],
      grants: ["unknown"],
      installUrl: file.download_url,
      rawUrl: file.download_url,
      sourceUrl: file.html_url || `https://github.com/${pageConfig.user}/${pageConfig.repo}/blob/main/${file.path}`,
      lines: null,
      fileName: file.name,
      path: file.path,
      hasMetadata: false,
    };
  }
}

function renderCatalog() {
  const visible = state.records.filter((record) => matchesQuery(record, state.query));
  elements.grid.innerHTML = "";

  if (!state.records.length) {
    elements.resultSummary.textContent = "0 scripts found in the publish folder.";
    elements.statusNote.textContent = "Add a .user.js file to the repository and reload the catalog.";
    renderEmptyState(
      "No scripts published yet",
      `Add a .user.js file to /${pageConfig.scriptsPath} and reload the page.`
    );
    return;
  }

  if (!visible.length) {
    renderEmptyState(
      "No matching scripts",
      "Try a broader search term or clear the search field."
    );
    elements.resultSummary.textContent = `0 results out of ${state.records.length} scripts.`;
    elements.statusNote.textContent = "Search checks script name, description, targets, version, and file name.";
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((record) => {
    fragment.appendChild(buildScriptCard(record));
  });

  elements.grid.appendChild(fragment);
  elements.resultSummary.textContent = `Showing ${visible.length} of ${state.records.length} scripts.`;
  elements.statusNote.textContent = "Install links point to the raw GitHub file. Source links open the repository page.";
}

function buildScriptCard(record) {
  const article = document.createElement("article");
  article.className = "script-card";

  const targetMarkup = record.targets.length
    ? record.targets.slice(0, 4).map((target) => createChipMarkup(target)).join("")
    : createChipMarkup("Target metadata missing", "chip chip--warning");

  const extraTargetCount = record.targets.length > 4
    ? `<span class="chip chip--muted">+${record.targets.length - 4} more</span>`
    : "";

  const meta = [
    record.lines ? `${formatNumber(record.lines)} lines` : "Line count unavailable",
    `Grant: ${record.grants[0] || "unknown"}`,
    record.fileName,
  ];

  article.innerHTML = `
    <div class="script-card__top">
      <div>
        <p class="script-card__kicker">Userscript</p>
        <h3>${escapeHtml(record.name)}</h3>
      </div>
      <span class="version-pill">v${escapeHtml(record.version)}</span>
    </div>

    <p class="script-card__description">${escapeHtml(record.description)}</p>

    <div class="script-card__meta">
      ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>

    <div class="script-card__targets">
      ${targetMarkup}
      ${extraTargetCount}
      <span class="chip chip--muted">${escapeHtml(record.namespace)}</span>
      ${record.hasMetadata ? "" : '<span class="chip chip--warning">Fallback card</span>'}
    </div>

    <div class="script-card__actions">
      <a class="button button--primary" href="${escapeAttribute(record.installUrl)}" target="_blank" rel="noreferrer">Install script</a>
      <a class="button button--secondary" href="${escapeAttribute(record.sourceUrl)}" target="_blank" rel="noreferrer">View source</a>
      <button class="button button--ghost" type="button" data-copy-url="${escapeAttribute(record.rawUrl)}">Copy raw URL</button>
    </div>

    <p class="script-card__footnote">
      If the install link opens raw code instead of an installer, add a userscript manager first and try again.
    </p>
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
      <div class="skeleton__line skeleton__line--text"></div>
      <div class="skeleton__line skeleton__line--text skeleton__line--short"></div>
      <div class="skeleton__line skeleton__line--text"></div>
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
  elements.resultSummary.textContent = "The catalog could not be loaded.";
  elements.statusNote.textContent = "Check the repository path, GitHub API rate limits, or the file structure.";
}

function updateStats(records) {
  const targets = new Set();
  records.forEach((record) => {
    record.targets.forEach((target) => targets.add(target));
  });

  elements.scriptCount.textContent = formatNumber(records.length);
  elements.targetCount.textContent = formatNumber(targets.size);
}

function parseUserscriptMetadata(source) {
  const meta = {
    match: [],
    include: [],
    grant: [],
  };

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
  const targets = rules
    .map(extractTarget)
    .filter(Boolean);

  return unique(targets);
}

function extractTarget(rule) {
  if (!rule) return "";
  if (rule === "<all_urls>") return "All URLs";
  if (rule.startsWith("file://")) return "Local files";

  const withoutScheme = rule.replace(/^[a-z*]+:\/\//i, "");
  const host = withoutScheme.split("/")[0].trim();

  if (!host || host === "*") {
    return "Any host";
  }

  return host;
}

function matchesQuery(record, query) {
  if (!query) return true;

  const haystack = [
    record.name,
    record.description,
    record.version,
    record.fileName,
    record.namespace,
    ...record.targets,
    ...record.matches,
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
  }, 2200);
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function createChipMarkup(text, className = "chip") {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function getGitHubErrorMessage(status) {
  if (status === 403) return "GitHub API rate limit reached. Try again a little later.";
  if (status === 404) return "Repository or /files folder was not found.";
  return `GitHub returned an unexpected status: ${status}.`;
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
