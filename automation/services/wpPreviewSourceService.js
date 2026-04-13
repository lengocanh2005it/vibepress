const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fse = require("fs-extra");
const mysql = require("mysql2/promise");
const { simpleGit } = require("simple-git");
const { GITHUB_TOKEN, TEMP_ROOT } = require("../config/constants");

const REPO_CACHE_ROOT = path.join(TEMP_ROOT, "theme-source-cache");
const REPO_REFRESH_MS = 5 * 60 * 1000;
const REPO_STATE = new Map();

function normalizeSourceToken(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.(php|html)$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function buildSourceNodeId(templateName, blockName, topLevelIndex) {
  return [
    normalizeSourceToken(templateName, "template"),
    normalizeSourceToken(blockName, "node"),
    String(topLevelIndex),
  ].join("::");
}

function inferTemplateHintFromRoute(route) {
  const normalizedRoute = String(route || "/").trim() || "/";
  if (normalizedRoute === "/" || normalizedRoute === "") return "front-page";
  if (/^\/category(\/|$)/i.test(normalizedRoute)) return "category";
  if (/^\/author(\/|$)/i.test(normalizedRoute)) return "author";
  if (/^\/tag(\/|$)/i.test(normalizedRoute)) return "tag";
  if (/^\/search(\/|$)/i.test(normalizedRoute)) return "search";
  if (/^\/wp-json(\/|$)/i.test(normalizedRoute)) return "index";
  return "page";
}

function parseBodyClasses(html) {
  const match = html.match(/<body[^>]*class=(["'])([^"']+)\1/i);
  if (!match) return [];
  return match[2]
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function inferTemplateHintFromHtmlAndRoute(html, route) {
  const bodyClasses = parseBodyClasses(html);
  const pageTemplateClass = bodyClasses.find((className) =>
    /^page-template-/.test(className),
  );
  if (pageTemplateClass) {
    const slug = pageTemplateClass
      .replace(/^page-template-/, "")
      .replace(/-php$/i, "")
      .replace(/\.php$/i, "");
    if (slug && slug !== "default") return slug;
  }

  if (bodyClasses.includes("front-page") || bodyClasses.includes("home")) {
    return "front-page";
  }
  if (bodyClasses.includes("single") || bodyClasses.some((className) => /^single-/.test(className))) {
    return "single";
  }
  if (bodyClasses.includes("page")) return "page";
  if (bodyClasses.includes("archive")) return "archive";
  if (bodyClasses.includes("category")) return "category";
  if (bodyClasses.includes("author")) return "author";
  if (bodyClasses.includes("tag")) return "tag";
  if (bodyClasses.includes("search")) return "search";
  if (bodyClasses.includes("error404")) return "404";

  return inferTemplateHintFromRoute(route);
}

function toRepoCloneUrl(repoUrl) {
  if (!repoUrl || !GITHUB_TOKEN) return repoUrl;
  if (!/^https:\/\/github\.com\//i.test(repoUrl)) return repoUrl;
  return repoUrl.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(GITHUB_TOKEN)}@`,
  );
}

async function ensureCachedRepo(repoUrl) {
  if (!repoUrl) return null;

  const cacheKey = crypto.createHash("sha1").update(repoUrl).digest("hex");
  const repoDir = path.join(REPO_CACHE_ROOT, cacheKey);
  const state = REPO_STATE.get(cacheKey);
  const now = Date.now();

  await fse.ensureDir(REPO_CACHE_ROOT);

  if (!fs.existsSync(repoDir)) {
    await simpleGit().clone(toRepoCloneUrl(repoUrl), repoDir, ["--depth", "1"]);
    REPO_STATE.set(cacheKey, { refreshedAt: now });
    return repoDir;
  }

  if (state && now - state.refreshedAt < REPO_REFRESH_MS) {
    return repoDir;
  }

  try {
    const git = simpleGit(repoDir);
    await git.fetch(["--depth", "1"]);
    await git.reset(["--hard", "FETCH_HEAD"]);
  } catch {
    // Keep the existing cached repo if refresh fails.
  }

  REPO_STATE.set(cacheKey, { refreshedAt: now });
  return repoDir;
}

async function resolveActiveThemeSlug(site) {
  const connectionString = site?.clonedDb?.connectionString;
  if (!connectionString) return null;

  let conn;
  try {
    conn = await mysql.createConnection(connectionString);
    const [tables] = await conn.query("SHOW TABLES");
    const optionsTable = (tables || [])
      .map((row) => Object.values(row)[0])
      .find((name) => typeof name === "string" && name.endsWith("_options"));

    if (!optionsTable) return null;

    const [rows] = await conn.query(
      `SELECT option_name, option_value FROM \`${optionsTable}\` WHERE option_name IN ('stylesheet', 'template')`,
    );
    const stylesheet = rows.find((row) => row.option_name === "stylesheet")?.option_value;
    const template = rows.find((row) => row.option_name === "template")?.option_value;
    return stylesheet || template || null;
  } catch {
    return null;
  } finally {
    try {
      await conn?.end();
    } catch {
      // ignore
    }
  }
}

function findThemeDirectoryCandidates(repoDir, activeThemeSlug) {
  const candidates = [];
  const possibleRoots = [
    path.join(repoDir, "wp-content", "themes"),
    path.join(repoDir, "themes"),
    repoDir,
  ];

  for (const root of possibleRoots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;

    if (activeThemeSlug) {
      const themed = path.join(root, activeThemeSlug);
      if (fs.existsSync(themed) && fs.statSync(themed).isDirectory()) {
        candidates.push(themed);
      }
    }

    const children = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dirPath) =>
        fs.existsSync(path.join(dirPath, "style.css")) ||
        fs.existsSync(path.join(dirPath, "theme.json")) ||
        fs.existsSync(path.join(dirPath, "templates")) ||
        fs.existsSync(path.join(dirPath, "parts")),
      );

    candidates.push(...children);
  }

  return [...new Set(candidates)];
}

function resolveThemeRoot(repoDir, activeThemeSlug) {
  const candidates = findThemeDirectoryCandidates(repoDir, activeThemeSlug);
  if (candidates.length === 0) return null;
  if (activeThemeSlug) {
    const exact = candidates.find(
      (candidate) => path.basename(candidate) === activeThemeSlug,
    );
    if (exact) return exact;
  }
  return candidates[0];
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function inferFseTemplateCandidates(templateHint, route) {
  const routeKey = String(route || "/").trim() || "/";
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  push(templateHint);
  if (routeKey === "/") {
    push("front-page");
    push("home");
    push("index");
    push("page");
  } else if (/^\/category(\/|$)/i.test(routeKey)) {
    push("category");
    push("archive");
    push("index");
  } else if (/^\/author(\/|$)/i.test(routeKey)) {
    push("author");
    push("archive");
    push("index");
  } else if (/^\/tag(\/|$)/i.test(routeKey)) {
    push("tag");
    push("archive");
    push("index");
  } else if (/^\/search(\/|$)/i.test(routeKey)) {
    push("search");
    push("archive");
    push("index");
  } else {
    push("page");
    push("index");
  }

  return candidates;
}

function resolveFseTemplate(themeRoot, templateHint, route) {
  const candidates = inferFseTemplateCandidates(templateHint, route);
  for (const candidate of candidates) {
    const templateFile = path.join(themeRoot, "templates", `${candidate}.html`);
    if (fileExists(templateFile)) {
      return {
        templateName: candidate,
        sourceFile: `templates/${candidate}.html`,
        markup: fs.readFileSync(templateFile, "utf8"),
      };
    }
  }
  return null;
}

function resolveFsePart(themeRoot, slug) {
  const candidates = [
    path.join(themeRoot, "parts", `${slug}.html`),
    path.join(themeRoot, "parts", `${slug}-default.html`),
  ];

  for (const filePath of candidates) {
    if (fileExists(filePath)) {
      const relative = path.relative(themeRoot, filePath).replace(/\\/g, "/");
      return {
        templateName: slug,
        sourceFile: relative,
        markup: fs.readFileSync(filePath, "utf8"),
      };
    }
  }

  return null;
}

function parseTopLevelBlockNames(markup) {
  const result = [];
  let remaining = String(markup || "").trim();

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (!remaining) break;

    const blockMatch = remaining.match(
      /^<!-- wp:([a-z][a-z0-9/\-]*)\s*(\{[\s\S]*?\})?\s*(\/?)-->/,
    );

    if (!blockMatch) {
      const nextBlock = remaining.indexOf("<!-- wp:");
      if (nextBlock === -1) break;
      remaining = remaining.slice(nextBlock);
      continue;
    }

    const fullMatch = blockMatch[0];
    const blockName = blockMatch[1];
    const selfClosing = blockMatch[3] === "/";
    remaining = remaining.slice(fullMatch.length);

    result.push(blockName);

    if (selfClosing) {
      continue;
    }

    const closeTag = `<!-- /wp:${blockName} -->`;
    const closeIdx = findClosingIndex(remaining, blockName, closeTag);

    if (closeIdx === -1) break;
    remaining = remaining.slice(closeIdx + closeTag.length);
  }

  return result;
}

function findClosingIndex(markup, blockName, closeTag) {
  const escapedName = blockName.replace("/", "\\/");
  const openPattern = new RegExp(`<!-- wp:${escapedName}[\\s{/]`);

  let depth = 1;
  let pos = 0;

  while (pos < markup.length && depth > 0) {
    const nextClose = markup.indexOf(closeTag, pos);
    if (nextClose === -1) return -1;

    const sub = markup.slice(pos);
    const nested = sub.match(openPattern);
    const nextOpen =
      nested && nested.index !== undefined ? pos + nested.index : -1;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      pos = nextOpen + 1;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose;
      pos = nextClose + closeTag.length;
    }
  }

  return -1;
}

function buildTopLevelSourceEntries(markup, templateName, sourceFile) {
  return parseTopLevelBlockNames(markup).map((blockName, index) => ({
    sourceNodeId: buildSourceNodeId(templateName, blockName, index),
    templateName,
    sourceFile,
    blockName,
    topLevelIndex: index,
  }));
}

function inferClassicSourceFile(themeRoot, templateHint, route) {
  const candidates = [];
  const push = (relativePath, templateName) => {
    const fullPath = path.join(themeRoot, relativePath);
    if (fileExists(fullPath)) {
      candidates.push({
        templateName,
        sourceFile: relativePath.replace(/\\/g, "/"),
      });
    }
  };

  push(`${templateHint}.php`, templateHint);
  if (route === "/") {
    push("front-page.php", "front-page");
    push("home.php", "home");
    push("index.php", "index");
    push("page.php", "page");
  } else {
    push("page.php", "page");
    push("index.php", "index");
  }

  return candidates[0] ?? null;
}

async function buildPreviewSourceContext({ site, targetUrl, html }) {
  const resolvedUrl = new URL(targetUrl);
  const route = resolvedUrl.pathname || "/";
  const templateHint = inferTemplateHintFromHtmlAndRoute(html, route);

  if (!site?.wpRepoUrl) {
    return {
      route,
      templateHint,
      sourceFile: "",
      sourceMap: [],
    };
  }

  try {
    const repoDir = await ensureCachedRepo(site.wpRepoUrl);
    if (!repoDir) {
      return { route, templateHint, sourceFile: "", sourceMap: [] };
    }

    const activeThemeSlug = await resolveActiveThemeSlug(site);
    const themeRoot = resolveThemeRoot(repoDir, activeThemeSlug);
    if (!themeRoot) {
      return { route, templateHint, sourceFile: "", sourceMap: [] };
    }

    const hasFseTemplates = fs.existsSync(path.join(themeRoot, "templates"));
    if (hasFseTemplates) {
      const pageTemplate = resolveFseTemplate(themeRoot, templateHint, route);
      const headerPart = resolveFsePart(themeRoot, "header");
      const footerPart = resolveFsePart(themeRoot, "footer");
      const sourceMap = [
        ...(headerPart
          ? buildTopLevelSourceEntries(
              headerPart.markup,
              headerPart.templateName,
              headerPart.sourceFile,
            )
          : []),
        ...(pageTemplate
          ? buildTopLevelSourceEntries(
              pageTemplate.markup,
              pageTemplate.templateName,
              pageTemplate.sourceFile,
            )
          : []),
        ...(footerPart
          ? buildTopLevelSourceEntries(
              footerPart.markup,
              footerPart.templateName,
              footerPart.sourceFile,
            )
          : []),
      ];

      return {
        route,
        templateHint: pageTemplate?.templateName || templateHint,
        sourceFile: pageTemplate?.sourceFile || "",
        sourceMap,
      };
    }

    const classicTemplate = inferClassicSourceFile(themeRoot, templateHint, route);
    return {
      route,
      templateHint: classicTemplate?.templateName || templateHint,
      sourceFile: classicTemplate?.sourceFile || "",
      sourceMap: [],
    };
  } catch {
    return {
      route,
      templateHint,
      sourceFile: "",
      sourceMap: [],
    };
  }
}

module.exports = {
  buildPreviewSourceContext,
};
