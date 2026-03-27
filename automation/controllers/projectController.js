const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const fse = require("fs-extra");
const { simpleGit } = require("simple-git");
const { extractWpress } = require("../utils/wpressExtractor");
const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  AI_PIPELINE_URL,
  DB_FILE,
  TEMP_ROOT,
  UPLOAD_ROOT,
} = require("../config/constants");

function ensureFileSystemState() {
  fse.ensureDirSync(TEMP_ROOT);
  fse.ensureDirSync(UPLOAD_ROOT);
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ projects: {} }, null, 2),
      "utf8",
    );
  }
}

function readDb() {
  const raw = fs.readFileSync(DB_FILE, "utf8");
  return JSON.parse(raw);
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function updateProject(projectId, updater) {
  const db = readDb();
  const project = db.projects[projectId];
  if (!project) {
    return null;
  }
  updater(project);
  writeDb(db);
  return project;
}

function generateProjectId() {
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function assertGithubConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN in environment variables");
  }
}

function buildAuthenticatedRepoUrl(htmlUrl) {
  return htmlUrl.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(GITHUB_TOKEN)}@`,
  );
}

async function createGithubRepo(name) {
  const url = "https://api.github.com/user/repos";
  const payload = {
    name,
    private: true,
    auto_init: false,
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    timeout: 15000,
  });

  return {
    name: response.data.name,
    htmlUrl: response.data.html_url,
  };
}

async function pushDirectoryToRepo(localDir, repoHtmlUrl, commitMessage) {
  const git = simpleGit(localDir);

  await git.init();
  await git.addConfig("user.name", GIT_AUTHOR_NAME);
  await git.addConfig("user.email", GIT_AUTHOR_EMAIL);
  await git.checkoutLocalBranch("main");
  await git.add(".");
  await git.commit(commitMessage);
  await git.addRemote("origin", buildAuthenticatedRepoUrl(repoHtmlUrl));
  await git.push(["-u", "origin", "main"]);
}

function cleanupWorkspace(workspaceRoot, uploadedZipPath) {
  if (workspaceRoot && fs.existsSync(workspaceRoot)) {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
  if (uploadedZipPath && fs.existsSync(uploadedZipPath)) {
    fs.rmSync(uploadedZipPath, { force: true });
  }
}

async function createProject(req, res) {
  try {
    assertGithubConfigured();
    const suffix = slugify(req.body?.projectName || "") || "theme";
    const projectId = generateProjectId();
    const wpRepoName = `wp-source-${suffix}-${projectId}`;

    const wpRepo = await createGithubRepo(wpRepoName);

    const db = readDb();
    db.projects[projectId] = {
      projectId,
      wpRepoName: wpRepo.name,
      wpRepoUrl: wpRepo.htmlUrl,
      owner: GITHUB_OWNER,
      status: "created",
      createdAt: new Date().toISOString(),
    };
    writeDb(db);

    return res.status(201).json({
      success: true,
      projectId,
      status: "created",
      wpRepoUrl: wpRepo.htmlUrl,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message =
      error.response?.data?.message || error.message || "CREATE_REPO_FAILED";
    return res.status(status).json({
      success: false,
      code: "CREATE_REPO_FAILED",
      message,
    });
  }
}

function getProjectById(req, res) {
  const db = readDb();
  const project = db.projects[req.params.projectId];
  if (!project) {
    return res.status(404).json({
      success: false,
      code: "PROJECT_NOT_FOUND",
      message: "Project not found",
    });
  }

  return res.json({ success: true, project });
}

async function uploadTheme(req, res) {
  const projectId = req.body?.projectId;
  const uploadedZipPath = req.file?.path;
  const originalName = req.file?.originalname || "";
  const workspaceRoot = projectId ? path.join(TEMP_ROOT, projectId) : null;

  if (!projectId) {
    cleanupWorkspace(workspaceRoot, uploadedZipPath);
    return res.status(400).json({
      success: false,
      code: "PROJECT_ID_REQUIRED",
      message: "projectId is required",
    });
  }

  if (!req.file || !originalName.toLowerCase().endsWith(".wpress")) {
    cleanupWorkspace(workspaceRoot, uploadedZipPath);
    return res.status(400).json({
      success: false,
      code: "INVALID_WPRESS",
      message: "Please upload a valid .wpress file",
    });
  }

  const db = readDb();
  const project = db.projects[projectId];
  if (!project) {
    cleanupWorkspace(workspaceRoot, uploadedZipPath);
    return res.status(404).json({
      success: false,
      code: "PROJECT_NOT_FOUND",
      message: "Project not found",
    });
  }

  const wpSourceDir = path.join(workspaceRoot, "wp-source");

  try {
    updateProject(projectId, (p) => {
      p.status = "uploading";
      p.updatedAt = new Date().toISOString();
    });

    await fse.ensureDir(wpSourceDir);

    await extractWpress(uploadedZipPath, wpSourceDir);

    // const dbInfo = await VPGetDbInfo();

    updateProject(projectId, (p) => {
      p.status = "pushing_wp_repo";
      // p.dbInfo = dbInfo;
      p.updatedAt = new Date().toISOString();
    });
    await pushDirectoryToRepo(
      wpSourceDir,
      project.wpRepoUrl,
      `Upload WP source for ${projectId}`,
    );

    // updateProject(projectId, (p) => {
    // 	p.status = 'running_mock_ai';
    // 	p.updatedAt = new Date().toISOString();
    // });
    // await simulateAIConversion(projectId, reactOutputDir);

    // updateProject(projectId, (p) => {
    // 	p.status = 'pushing_react_repo';
    // 	p.updatedAt = new Date().toISOString();
    // });
    // await pushDirectoryToRepo(reactOutputDir, project.reactRepoUrl, `Mock AI output for ${projectId}`);

    updateProject(projectId, (p) => {
      p.status = "completed";
      p.updatedAt = new Date().toISOString();
    });

    return res.status(200).json({
      success: true,
      projectId,
      message: "Bien doi thanh cong! Nguon WP da duoc upload len GitHub.",
      wpRepoUrl: project.wpRepoUrl,
      // dbInfo,
    });
  } catch (error) {
    console.error("[uploadTheme] error:", error);
    updateProject(projectId, (p) => {
      p.status = "failed";
      p.updatedAt = new Date().toISOString();
      p.errorCode = error.message || "UNKNOWN_ERROR";
    });

    return res.status(500).json({
      success: false,
      projectId,
      code: "UPLOAD_PROCESS_FAILED",
      message: error.message || "Xu ly that bai",
    });
  } finally {
    cleanupWorkspace(workspaceRoot, uploadedZipPath);
  }
}

// -------------------------------------------------------
// HELPERS cho wpSites
// -------------------------------------------------------
function findSiteByApiKey(apiKey) {
  const db = readDb();
  return (
    Object.values(db.wpSites ?? {}).find((s) => s.apiKey === apiKey) ?? null
  );
}

function findSiteBySiteUrl(siteUrl) {
  const db = readDb();
  return (
    Object.values(db.wpSites ?? {}).find((s) => s.siteUrl === siteUrl) ?? null
  );
}

// -------------------------------------------------------
// POST /api/wp/register
// Nhận từ WP plugin: siteUrl, siteName, wpVersion, adminEmail, dbInfo
// Trả về: { apiKey, githubToken, githubRepo }
// -------------------------------------------------------
async function registerWpSite(req, res) {
  console.log(`[WP] POST /wp/register — body:`, {
    siteUrl: req.body?.siteUrl,
    siteName: req.body?.siteName,
    wpVersion: req.body?.wpVersion,
    adminEmail: req.body?.adminEmail,
    hasDbInfo: !!req.body?.dbInfo,
  });

  const { siteUrl, siteName, wpVersion, adminEmail, dbInfo } = req.body ?? {};

  if (!siteUrl) {
    console.warn(`[WP] register FAILED — siteUrl missing`);
    return res
      .status(400)
      .json({ success: false, error: "siteUrl is required" });
  }

  try {
    assertGithubConfigured();
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }

  const apiKey = crypto.randomBytes(32).toString("hex");

  // Kiểm tra site đã tồn tại chưa (reconnect vs first connect)
  const existingSite = findSiteBySiteUrl(siteUrl);

  if (existingSite) {
    // RECONNECT — giữ nguyên repo, chỉ cấp apiKey mới
    const db = readDb();
    db.wpSites[existingSite.siteId].apiKey = apiKey;
    db.wpSites[existingSite.siteId].siteName =
      siteName ?? existingSite.siteName;
    db.wpSites[existingSite.siteId].wpVersion =
      wpVersion ?? existingSite.wpVersion;
    db.wpSites[existingSite.siteId].adminEmail =
      adminEmail ?? existingSite.adminEmail;
    db.wpSites[existingSite.siteId].dbInfo = dbInfo ?? existingSite.dbInfo;
    db.wpSites[existingSite.siteId].updatedAt = new Date().toISOString();
    writeDb(db);

    const githubRepo = existingSite.wpRepoUrl.replace(
      "https://github.com/",
      "",
    );
    console.log(
      `[WP] register (reconnect) OK — siteUrl=${siteUrl} repo=${existingSite.wpRepoUrl}`,
    );
    return res.status(200).json({
      apiKey,
      githubToken: GITHUB_TOKEN,
      githubRepo,
      isFirstConnect: false,
    });
  }

  // FIRST CONNECT — tạo GitHub repo mới
  const siteId = `wp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const repoSuffix = slugify(siteName || siteUrl).slice(0, 20) || "site";
  const repoName = `wp-site-${repoSuffix}-${siteId.slice(-8)}`;
  let wpRepo;
  try {
    wpRepo = await createGithubRepo(repoName);
    console.log(`[WP] register — created GitHub repo: ${wpRepo.htmlUrl}`);
  } catch (e) {
    console.error(
      `[WP] register FAILED — could not create GitHub repo:`,
      e.message,
    );
    return res.status(500).json({
      success: false,
      error: `Failed to create GitHub repo: ${e.response?.data?.message || e.message}`,
    });
  }

  const db = readDb();
  if (!db.wpSites) db.wpSites = {};

  db.wpSites[siteId] = {
    siteId,
    siteUrl,
    siteName: siteName ?? null,
    wpVersion: wpVersion ?? null,
    adminEmail: adminEmail ?? null,
    dbInfo: dbInfo ?? null,
    apiKey,
    wpRepoName: wpRepo.name,
    wpRepoUrl: wpRepo.htmlUrl,
    registeredAt: new Date().toISOString(),
  };
  writeDb(db);

  console.log(
    `[WP] register (first connect) OK — siteUrl=${siteUrl} siteId=${siteId} repo=${wpRepo.htmlUrl}`,
  );

  const githubRepo = wpRepo.htmlUrl.replace("https://github.com/", "");
  return res.status(200).json({
    apiKey,
    githubToken: GITHUB_TOKEN,
    githubRepo,
    isFirstConnect: true,
  });
}

// -------------------------------------------------------
// POST /api/wp/get-token
// Header: X-Vibepress-Key
// Body: { siteUrl }
// Trả về: { githubToken } — plugin cache 55 phút rồi gọi lại endpoint này
// -------------------------------------------------------
function getToken(req, res) {
  const apiKey = req.headers["x-vibepress-key"];

  if (!apiKey) {
    return res
      .status(401)
      .json({ success: false, error: "Missing X-Vibepress-Key header" });
  }

  const site = findSiteByApiKey(apiKey);
  if (!site) {
    console.warn(
      `[WP] get-token FAILED — invalid API key ${apiKey.slice(0, 8)}…`,
    );
    return res.status(401).json({ success: false, error: "Invalid API key" });
  }

  console.log(`[WP] get-token OK — site=${site.siteUrl}`);
  return res.status(200).json({ githubToken: GITHUB_TOKEN });
}

// -------------------------------------------------------
// POST /api/wp/sync-complete
// Plugin gọi sau khi vpdb_sync_theme_bg() hoàn tất
// Header: X-Vibepress-Key
// Body: { siteUrl, repoName, themeName, synced, failed, success, syncedAt }
// -------------------------------------------------------
function syncComplete(req, res) {
  const apiKey = req.headers["x-vibepress-key"];
  if (!apiKey) {
    return res
      .status(401)
      .json({ success: false, error: "Missing X-Vibepress-Key header" });
  }

  const site = findSiteByApiKey(apiKey);
  if (!site) {
    console.warn(
      `[WP] sync-complete FAILED — invalid API key ${apiKey.slice(0, 8)}…`,
    );
    return res.status(401).json({ success: false, error: "Invalid API key" });
  }

  const {
    themeName,
    synced,
    failed,
    success: syncSuccess,
    syncedAt,
  } = req.body ?? {};

  const db = readDb();
  const record = (db.wpSites ?? {})[site.siteId];
  if (record) {
    record.lastSync = {
      themeName: themeName ?? null,
      synced: synced ?? 0,
      failed: failed ?? 0,
      success: syncSuccess ?? false,
      syncedAt: syncedAt ?? new Date().toISOString(),
    };
    writeDb(db);
  }

  console.log(
    `[WP] sync-complete OK — site=${site.siteUrl} synced=${synced} failed=${failed}`,
  );

  // Trigger pipeline
  if (site.dbInfo) {
    const dbInfo = {
      host: "localhost",
      port: site.dbInfo.db_port,
      dbName: site.dbInfo.db_name,
      password: site.dbInfo.db_password,
      user: site.dbInfo.db_user,
    };

    axios
      .post(`${AI_PIPELINE_URL}/pipeline/run`, {
        themeGithubUrl: site.wpRepoUrl,
        dbCredentials: dbInfo,
      })
      .then(() => {
        console.log(`[WP] Triggered pipeline for ${site.siteUrl}`);
      })
      .catch((error) => {
        console.error(
          `[WP] Failed to trigger pipeline for ${site.siteUrl}`,
          error,
        );
      });
  }

  return res.status(200).json({ success: true });
}

// -------------------------------------------------------
// GET /api/wp/repos?email=xxx
// Trả về danh sách repo của tất cả wpSites có adminEmail khớp
// -------------------------------------------------------
function getReposByEmail(req, res) {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ success: false, error: "email query param is required" });
  }

  const db = readDb();
  const sites = Object.values(db.wpSites ?? {}).filter(
    (s) => s.adminEmail?.toLowerCase() === email.toLowerCase()
  );

  const repos = sites.map((s) => ({
    siteId: s.siteId,
    siteUrl: s.siteUrl,
    siteName: s.siteName,
    wpRepoName: s.wpRepoName,
    wpRepoUrl: s.wpRepoUrl,
    registeredAt: s.registeredAt,
  }));

  return res.status(200).json({ success: true, email, repos });
}

// -------------------------------------------------------
// GET /api/wp/commits?repoUrl=https://github.com/owner/repo
// Trả về lịch sử commit của repo từ GitHub API
// -------------------------------------------------------
async function getCommitsByRepo(req, res) {
  const { repoUrl } = req.query;

  if (!repoUrl) {
    return res.status(400).json({ success: false, error: "repoUrl query param is required" });
  }

  // Parse owner/repo từ URL dạng https://github.com/owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    return res.status(400).json({ success: false, error: "Invalid GitHub repo URL" });
  }

  const [, owner, repo] = match;

  try {
    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/commits`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        params: { per_page: 20 },
        timeout: 10000,
      }
    );

    const commits = response.data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      avatarUrl: c.author?.avatar_url ?? null,
    }));

    return res.status(200).json({ success: true, owner, repo, commits });
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({
      success: false,
      error: error.response?.data?.message || error.message,
    });
  }
}

// -------------------------------------------------------
// GET /api/wp/site-pages?siteUrl=http://localhost:8000
// Proxy gọi WP REST API lấy danh sách pages
// -------------------------------------------------------
async function getWpSitePages(req, res) {
  const { siteUrl } = req.query;

  if (!siteUrl) {
    return res.status(400).json({ success: false, error: "siteUrl query param is required" });
  }

  try {
    const response = await axios.get(
      `${siteUrl}/wp-json/wp/v2/pages`,
      { params: { per_page: 100, _fields: "id,title,link,slug,status" }, timeout: 10000 }
    );

    const pages = [
      { id: 1, title: "Trang chủ", slug: "", link: siteUrl, status: "publish" },
      ...response.data.map((p) => ({
        id: p.id,
        title: p.title?.rendered ?? p.slug,
        slug: p.slug,
        link: p.link,
        status: p.status,
      })),
    ];

    

    return res.status(200).json({ success: true, pages });
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({
      success: false,
      error: error.response?.data?.message || error.message,
    });
  }
}

module.exports = {
  ensureFileSystemState,
  createProject,
  getProjectById,
  uploadTheme,
  registerWpSite,
  getToken,
  syncComplete,
  getReposByEmail,
  getCommitsByRepo,
  getWpSitePages,
};
