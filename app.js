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
};

const elements = {
  repoLink: document.getElementById("repoLink"),
  list: document.getElementById("list"),
  toast: document.getElementById("toast"),
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
let toastTimer = null;

init();

function init() {
  const repoUrl = `https://github.com/${pageConfig.user}/${pageConfig.repo}`;
  elements.repoLink.href = repoUrl;

  elements.list.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("[data-copy-url]");
    if (!copyButton) return;

    const rawUrl = copyButton.getAttribute("data-copy-url");
    if (!rawUrl) return;

    try {
      await navigator.clipboard.writeText(rawUrl);
      showToast("Raw URL copied.");
    } catch (error) {
      showToast("Could not copy the raw URL.");
    }
  });

  renderLoadingState();
  loadScripts();
}

async function loadScripts({ forceReload = false } = {}) {
  renderLoadingState();

  try {
    const url = `https://api.github.com/repos/${pageConfig.user}/${pageConfig.repo}/contents/${pageConfig.scriptsPath}`;
    const response = await fetch(url, {
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
    renderList();
  } catch (error) {
    state.records = [];
    renderError(error instanceof Error ? error.message : "Could not load scripts.");
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
      fileName: file.name,
      installUrl: meta.downloadURL || file.download_url,
      sourceUrl: file.html_url,
      rawUrl: file.download_url,
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
      fileName: file.name,
      installUrl: file.download_url,
      sourceUrl: file.html_url,
      rawUrl: file.download_url,
      lines: null,
      hasMetadata: false,
    };
  }
}

function renderList() {
  if (!state.records.length) {
    renderEmpty(
      "No scripts yet",
      `Add .user.js files to /${pageConfig.scriptsPath} and refresh the page.`
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  state.records.forEach((record) => {
    fragment.appendChild(buildCard(record));
  });

  elements.list.replaceChildren(fragment);
}

function buildCard(record) {
  const card = document.createElement("article");
  card.className = "card";

  const targetsText = record.targets.length
    ? `Targets: ${shortenTargets(record.targets)}`
    : "Targets: not specified";

  const metaParts = [];
  if (record.lines) metaParts.push(`${formatNumber(record.lines)} lines`);
  if (record.grants[0]) metaParts.push(`Grant: ${record.grants[0]}`);
  if (!record.hasMetadata) metaParts.push("Fallback data");

  card.innerHTML = `
    <div class="card-head">
      <div>
        <h2>${escapeHtml(record.name)}</h2>
      </div>
      <span class="version">v${escapeHtml(record.version)}</span>
    </div>

    <p class="description">${escapeHtml(record.description)}</p>
    <div class="meta">
      <span>${escapeHtml(record.fileName)}</span>
      ${metaParts.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>
    <p class="targets">${escapeHtml(targetsText)}</p>

    <div class="buttons">
      <a class="link-button link-button--primary" href="${escapeAttribute(record.installUrl)}" target="_blank" rel="noreferrer">Install</a>
      <a class="link-button" href="${escapeAttribute(record.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>
      <button class="action-button" type="button" data-copy-url="${escapeAttribute(record.rawUrl)}">Copy raw URL</button>
    </div>
  `;

  return card;
}

function renderLoadingState() {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < 3; index += 1) {
    const card = document.createElement("div");
    card.className = "card skeleton";
    card.innerHTML = `
      <div class="skeleton-line skeleton-line--title"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line skeleton-line--short"></div>
      <div class="skeleton-line"></div>
    `;
    fragment.appendChild(card);
  }

  elements.list.replaceChildren(fragment);
}

function renderEmpty(title, text) {
  const box = document.createElement("div");
  box.className = "empty";
  box.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(text)}</p>
  `;
  elements.list.replaceChildren(box);
}

function renderError(message) {
  const box = document.createElement("div");
  box.className = "error";
  box.innerHTML = `
    <h3>Loading error</h3>
    <p>${escapeHtml(message)}</p>
  `;
  elements.list.replaceChildren(box);
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

function getGitHubErrorMessage(status) {
  if (status === 403) return "GitHub API rate limit reached. Try again later.";
  if (status === 404) return "Repository or files folder was not found.";
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
