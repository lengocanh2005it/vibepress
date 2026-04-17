const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const fse = require("fs-extra");
const {
  getTables,
  getTableRows,
  dumpFullTable,
  dumpAllTables,
  dumpToSql,
} = require("../services/wpSqlDumpService");
const {
  createSiteDatabase,
  dropSiteDatabase,
  syncPostToLocalDb,
  deletePostFromLocalDb,
} = require("../services/siteDbService");
const { simpleGit } = require("simple-git");
const { extractWpress } = require("../utils/wpressExtractor");
const { query, queryOne } = require("../db/mysql");
const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DB_FILE,
  TEMP_ROOT,
  UPLOAD_ROOT,
} = require("../config/constants");
const {
  injectWpPreviewMetadata,
} = require("../services/wpPreviewInstrumentation");
const {
  buildPreviewSourceContext,
} = require("../services/wpPreviewSourceService");

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

function buildReachableUrlCandidates(rawUrl) {
  if (!rawUrl) return [];

  const candidates = [rawUrl];

  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = "host.docker.internal";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    } else if (parsed.hostname === "host.docker.internal") {
      parsed.hostname = "localhost";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    }
  } catch {
    // Giữ nguyên rawUrl nếu parse thất bại.
  }

  return [...new Set(candidates)];
}

async function axiosGetWithFallback(rawUrl, config = {}) {
  const candidates = buildReachableUrlCandidates(rawUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      return await axios.get(candidate, config);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function dumpAllTablesWithFallback(siteUrl, apiKey, onTable = null) {
  const candidates = buildReachableUrlCandidates(siteUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      return {
        tables: await dumpAllTables(candidate, apiKey, onTable),
        resolvedUrl: candidate,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
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
// HELPERS cho wpSites — MySQL
// -------------------------------------------------------

/** Chuyển snake_case row từ MySQL → camelCase object dùng trong controller */
function normalizeSite(row) {
  if (!row) return null;
  return {
    siteId: row.site_id,
    userId: row.user_id,
    siteUrl: row.site_url,
    siteName: row.site_name,
    wpVersion: row.wp_version,
    adminEmail: row.admin_email,
    apiKey: row.api_key,
    wpRepoName: row.wp_repo_name,
    wpRepoUrl: row.wp_repo_url,
    clonedDb: row.cloned_db
      ? typeof row.cloned_db === "string"
        ? JSON.parse(row.cloned_db)
        : row.cloned_db
      : null,
    lastSync: row.last_sync
      ? typeof row.last_sync === "string"
        ? JSON.parse(row.last_sync)
        : row.last_sync
      : null,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

async function findSiteByApiKey(apiKey) {
  const row = await queryOne(
    "SELECT * FROM wp_sites WHERE api_key = ? LIMIT 1",
    [apiKey],
  );
  return normalizeSite(row);
}

async function findSiteBySiteUrl(siteUrl) {
  const row = await queryOne("SELECT * FROM wp_sites WHERE site_url = ?", [
    siteUrl,
  ]);
  return normalizeSite(row);
}

async function findSiteBySiteId(siteId) {
  const row = await queryOne("SELECT * FROM wp_sites WHERE site_id = ? LIMIT 1", [
    siteId,
  ]);
  return normalizeSite(row);
}

// -------------------------------------------------------
// Helper: dump SQL từ WP rồi import vào local MySQL (chạy background)
// Delay để plugin kịp lưu apiKey trước khi ta gọi endpoint dump
// -------------------------------------------------------
async function triggerDbSync(siteId, siteUrl, apiKey, delayMs = 5000) {
  await new Promise((r) => setTimeout(r, delayMs));

  const dumpDir = path.join(__dirname, "..", "temp_dumps");
  fse.ensureDirSync(dumpDir);
  const dumpPath = path.join(dumpDir, `dump-${siteId}-${Date.now()}.sql`);

  try {
    console.log(`[DbSync] start — siteId=${siteId} url=${siteUrl}`);
    const { tables, resolvedUrl } = await dumpAllTablesWithFallback(
      siteUrl,
      apiKey,
    );
    if (resolvedUrl !== siteUrl) {
      console.log(
        `[DbSync] using fallback url — siteId=${siteId} url=${resolvedUrl}`,
      );
    }
    const sql = dumpToSql(tables);
    fs.writeFileSync(dumpPath, sql, "utf8");
    console.log(`[DbSync] dump saved — ${dumpPath}`);

    await dropSiteDatabase(siteId);
    const dbInfo = await createSiteDatabase(siteId, dumpPath);
    console.log(
      `[DbSync] DB created — ${dbInfo.dbName} (${dbInfo.tables} tables, ${dbInfo.totalRows} rows)`,
    );

    await query("UPDATE wp_sites SET cloned_db = ? WHERE site_id = ?", [
      JSON.stringify(dbInfo),
      siteId,
    ]);
  } catch (e) {
    console.error(
      `[DbSync] FAILED — siteId=${siteId}:`,
      e?.message || e?.code || String(e),
    );
  } finally {
    if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath);
  }
}

// -------------------------------------------------------
// POST /api/wp/register
// Header: X-Vibepress-Key (user's API key từ Vibepress platform)
// Body: { siteUrl, siteName, wpVersion, adminEmail }
// Trả về: { githubToken, githubRepo, isFirstConnect }
// -------------------------------------------------------
async function registerWpSite(req, res) {
  const apiKey = req.headers["x-vibepress-key"];
  const { siteUrl, siteName, wpVersion, adminEmail } = req.body ?? {};

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error:
        "Thiếu X-Vibepress-Key header. Vui lòng nhập API Key trong cài đặt plugin.",
    });
  }
  if (!siteUrl) {
    return res
      .status(400)
      .json({ success: false, error: "siteUrl is required" });
  }

  // Validate API key — phải thuộc về 1 user trong hệ thống
  const user = await queryOne("SELECT id FROM users WHERE api_key = ?", [
    apiKey,
  ]);
  if (!user) {
    console.warn(
      `[WP] register FAILED — invalid API key ${apiKey.slice(0, 8)}…`,
    );
    return res.status(401).json({
      success: false,
      error:
        "API Key không hợp lệ. Kiểm tra lại trong trang tài khoản Vibepress.",
    });
  }

  try {
    assertGithubConfigured();
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }

  // Kiểm tra site đã tồn tại chưa (reconnect vs first connect)
  const existingSite = await findSiteBySiteUrl(siteUrl);

  if (existingSite) {
    // RECONNECT — cập nhật metadata site, thêm user vào wp_site_members nếu chưa có
    await query(
      `UPDATE wp_sites SET site_name = ?, wp_version = ?, admin_email = ? WHERE site_id = ?`,
      [
        siteName ?? existingSite.siteName,
        wpVersion ?? existingSite.wpVersion,
        adminEmail ?? existingSite.adminEmail,
        existingSite.siteId,
      ],
    );

    await query(
      `INSERT IGNORE INTO wp_site_members (site_id, user_id) VALUES (?, ?)`,
      [existingSite.siteId, user.id],
    );

    const githubRepo = existingSite.wpRepoUrl.replace("https://github.com/", "");
    console.log(`[WP] register (reconnect) OK — siteUrl=${siteUrl} userId=${user.id}`);
    res.status(200).json({ githubToken: GITHUB_TOKEN, githubRepo, isFirstConnect: false });
    triggerDbSync(existingSite.siteId, siteUrl, apiKey);
    return;
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

  await query(
    `INSERT INTO wp_sites (site_id, user_id, site_url, site_name, wp_version, admin_email, api_key, wp_repo_name, wp_repo_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [siteId, user.id, siteUrl, siteName ?? null, wpVersion ?? null, adminEmail ?? null, apiKey, wpRepo.name, wpRepo.htmlUrl],
  );

  await query(
    `INSERT IGNORE INTO wp_site_members (site_id, user_id) VALUES (?, ?)`,
    [siteId, user.id],
  );

  console.log(
    `[WP] register (first connect) OK — siteUrl=${siteUrl} siteId=${siteId} userId=${user.id}`,
  );

  const githubRepo = wpRepo.htmlUrl.replace("https://github.com/", "");
  res
    .status(200)
    .json({ githubToken: GITHUB_TOKEN, githubRepo, isFirstConnect: true });
  triggerDbSync(siteId, siteUrl, apiKey);
}

// -------------------------------------------------------
// POST /api/wp/get-token
// Header: X-Vibepress-Key
// Body: { siteUrl }
// Trả về: { githubToken } — plugin cache 55 phút rồi gọi lại endpoint này
// -------------------------------------------------------
async function getToken(req, res) {
  const apiKey = req.headers["x-vibepress-key"];

  if (!apiKey) {
    return res
      .status(401)
      .json({ success: false, error: "Missing X-Vibepress-Key header" });
  }

  const site = await findSiteByApiKey(apiKey);
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
async function syncComplete(req, res) {
  const apiKey = req.headers["x-vibepress-key"];
  if (!apiKey) {
    return res
      .status(401)
      .json({ success: false, error: "Missing X-Vibepress-Key header" });
  }

  const site = await findSiteByApiKey(apiKey);
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

  const lastSync = {
    themeName: themeName ?? null,
    synced: synced ?? 0,
    failed: failed ?? 0,
    success: syncSuccess ?? false,
    syncedAt: syncedAt ?? new Date().toISOString(),
  };

  await query("UPDATE wp_sites SET last_sync = ? WHERE site_id = ?", [
    JSON.stringify(lastSync),
    site.siteId,
  ]);

  console.log(
    `[WP] sync-complete OK — site=${site.siteUrl} synced=${synced} failed=${failed}`,
  );
  return res.status(200).json({ success: true });
}

// -------------------------------------------------------
// GET /api/wp/repos
// Header: Authorization: Bearer <jwt>
// Trả về danh sách wp_sites thuộc về user đang đăng nhập
// -------------------------------------------------------
async function getReposByEmail(req, res) {
  const userId = req.user.id;

  const rows = await query(
    `SELECT s.*, m.joined_at
     FROM wp_sites s
     INNER JOIN wp_site_members m ON m.site_id = s.site_id
     WHERE m.user_id = ?
     ORDER BY m.joined_at DESC`,
    [userId],
  );

  const repos = rows.map((r) => ({
    siteId: r.site_id,
    siteUrl: r.site_url,
    siteName: r.site_name,
    wpRepoName: r.wp_repo_name,
    wpRepoUrl: r.wp_repo_url,
    clonedDb: r.cloned_db
      ? typeof r.cloned_db === "string"
        ? JSON.parse(r.cloned_db)
        : r.cloned_db
      : null,
    registeredAt: r.registered_at,
  }));

  return res.status(200).json({ success: true, repos });
}

async function getDBinfoBySiteId(req, res) {
  const { siteId } = req.query;

  if (!siteId) {
    return res
      .status(400)
      .json({ success: false, error: "siteId query param is required" });
  }

  const row = await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [
    siteId,
  ]);
  if (!row) {
    return res
      .status(404)
      .json({ success: false, error: "No site found for this siteId" });
  }

  const site = normalizeSite(row);

  return res.status(200).json({
    themeGithubUrl: site.wpRepoUrl,
    dbConnectionString: site.clonedDb?.connectionString ?? null,
  });
}

// -------------------------------------------------------
// GET /api/wp/sql-dump/tables?siteId=xxx
// Trả về danh sách tables + row count + schema
// -------------------------------------------------------
async function getSqlDumpTables(req, res) {
  const { siteId } = req.query;
  if (!siteId) {
    return res
      .status(400)
      .json({ success: false, error: "siteId is required" });
  }

  const site = normalizeSite(
    await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [siteId]),
  );
  if (!site) {
    return res.status(404).json({ success: false, error: "Site not found" });
  }

  try {
    const data = await getTables(site.siteUrl, site.apiKey);
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[SqlDump] getTables FAILED — siteId=${siteId}:`, e.message);
    return res.status(502).json({ success: false, error: e.message });
  }
}

// -------------------------------------------------------
// GET /api/wp/sql-dump?siteId=xxx&table=wp_posts&offset=0&limit=500
// Trả về rows của 1 table, có phân trang
// -------------------------------------------------------
async function getSqlDumpRows(req, res) {
  const { siteId, table, offset, limit } = req.query;
  if (!siteId || !table) {
    return res
      .status(400)
      .json({ success: false, error: "siteId and table are required" });
  }

  const site = normalizeSite(
    await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [siteId]),
  );
  if (!site) {
    return res.status(404).json({ success: false, error: "Site not found" });
  }

  try {
    const data = await getTableRows(
      site.siteUrl,
      site.apiKey,
      table,
      Number(offset ?? 0),
      Number(limit ?? 500),
    );
    return res.status(200).json(data);
  } catch (e) {
    console.error(
      `[SqlDump] getTableRows FAILED — siteId=${siteId} table=${table}:`,
      e.message,
    );
    return res.status(502).json({ success: false, error: e.message });
  }
}

// -------------------------------------------------------
// GET /api/wp/sql-dump/full?siteId=xxx&table=wp_posts
// Dump toàn bộ 1 table (tự động phân trang)
// -------------------------------------------------------
async function getSqlDumpFullTable(req, res) {
  const { siteId, table } = req.query;
  if (!siteId || !table) {
    return res
      .status(400)
      .json({ success: false, error: "siteId and table are required" });
  }

  const site = normalizeSite(
    await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [siteId]),
  );
  if (!site) {
    return res.status(404).json({ success: false, error: "Site not found" });
  }

  try {
    const data = await dumpFullTable(site.siteUrl, site.apiKey, table);
    return res.status(200).json(data);
  } catch (e) {
    console.error(
      `[SqlDump] dumpFullTable FAILED — siteId=${siteId} table=${table}:`,
      e.message,
    );
    return res.status(502).json({ success: false, error: e.message });
  }
}

// -------------------------------------------------------
// GET /api/wp/sql-dump/all?siteId=xxx
// Dump toàn bộ database — lưu file .sql vào temp_dumps/, trả về đường dẫn
// -------------------------------------------------------
async function getSqlDumpAll(req, res) {
  const { siteId } = req.query;
  if (!siteId) {
    return res
      .status(400)
      .json({ success: false, error: "siteId is required" });
  }

  const site = normalizeSite(
    await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [siteId]),
  );
  if (!site) {
    return res.status(404).json({ success: false, error: "Site not found" });
  }

  const dumpDir = path.join(__dirname, "..", "temp_dumps");
  fse.ensureDirSync(dumpDir);

  const filename = `dump-${siteId}-${Date.now()}.sql`;
  const filepath = path.join(dumpDir, filename);

  try {
    const tables = await dumpAllTables(site.siteUrl, site.apiKey);
    const sql = dumpToSql(tables);
    fs.writeFileSync(filepath, sql, "utf8");

    console.log(`[SqlDump] saved — ${filepath}`);

    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).sendFile(filepath);
  } catch (e) {
    console.error(
      `[SqlDump] dumpAllTables FAILED — siteId=${siteId}:`,
      e.message,
    );
    return res.status(502).json({ success: false, error: e.message });
  }
}

// -------------------------------------------------------
// POST /api/wp/create-db?siteId=xxx
// Dump SQL từ WP → tạo database trên local MySQL → lưu connection string vào MySQL
// -------------------------------------------------------
async function createSiteDb(req, res) {
  const { siteId } = req.query;
  if (!siteId) {
    return res
      .status(400)
      .json({ success: false, error: "siteId is required" });
  }

  const site = normalizeSite(
    await queryOne("SELECT * FROM wp_sites WHERE site_id = ?", [siteId]),
  );
  if (!site) {
    return res.status(404).json({ success: false, error: "Site not found" });
  }

  const dumpDir = path.join(__dirname, "..", "temp_dumps");
  fse.ensureDirSync(dumpDir);
  const dumpPath = path.join(dumpDir, `dump-${siteId}-${Date.now()}.sql`);

  try {
    // 1. Dump SQL từ WP
    const { tables, resolvedUrl } = await dumpAllTablesWithFallback(
      site.siteUrl,
      site.apiKey,
    );
    if (resolvedUrl !== site.siteUrl) {
      console.log(
        `[CreateDb] using fallback url — siteId=${siteId} url=${resolvedUrl}`,
      );
    }
    const sql = dumpToSql(tables);
    fs.writeFileSync(dumpPath, sql, "utf8");
    console.log(`[CreateDb] dump saved — ${dumpPath}`);

    // 2. Tạo database trên local MySQL và import
    const dbInfo = await createSiteDatabase(siteId, dumpPath);
    console.log(
      `[CreateDb] DB created — ${dbInfo.dbName} (${dbInfo.tables} tables, ${dbInfo.totalRows} rows)`,
    );

    // 3. Lưu vào MySQL
    await query("UPDATE wp_sites SET cloned_db = ? WHERE site_id = ?", [
      JSON.stringify(dbInfo),
      siteId,
    ]);

    return res.status(200).json({ success: true, clonedDb: dbInfo });
  } catch (e) {
    console.error(`[CreateDb] FAILED — siteId=${siteId}:`, e.message);
    return res.status(502).json({ success: false, error: e.message });
  }
}

// -------------------------------------------------------
// POST /api/wp/notify-content-change
// Plugin gọi sau save_post / before_delete_post (non-blocking).
// Backend fetch post data từ plugin rồi REPLACE INTO / DELETE trên local MySQL.
// -------------------------------------------------------
async function notifyContentChange(req, res) {
  const apiKey = req.headers["x-vibepress-key"];
  const { siteUrl, postId, action } = req.body ?? {};

  if (!postId || !siteUrl) {
    return res
      .status(400)
      .json({ success: false, error: "siteUrl and postId are required" });
  }

  const site = normalizeSite(
    await queryOne(
      "SELECT * FROM wp_sites WHERE site_url = ? AND api_key = ?",
      [siteUrl, apiKey],
    ),
  );
  if (!site) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Trả ngay để plugin không bị block
  res.status(202).json({ success: true });

  try {
    if (action === "delete") {
      await deletePostFromLocalDb(site.siteId, postId);
      console.log(
        `[ContentSync] deleted postId=${postId} from local DB — siteId=${site.siteId}`,
      );
      return;
    }

    // Fetch post data từ plugin endpoint
    const response = await axios.get(
      `${siteUrl}/wp-json/vibepress/v1/post-data`,
      {
        params: { post_id: postId },
        headers: { "X-Vibepress-Key": site.apiKey },
        timeout: 15000,
      },
    );

    await syncPostToLocalDb(site.siteId, response.data);
    console.log(
      `[ContentSync] synced postId=${postId} to local DB — siteId=${site.siteId}`,
    );
  } catch (e) {
    console.error(
      `[ContentSync] FAILED postId=${postId} siteId=${site.siteId}:`,
      e.message,
    );
  }
}

// -------------------------------------------------------
// GET /api/wp/commits?repoUrl=https://github.com/owner/repo
// Trả về lịch sử commit của repo từ GitHub API
// -------------------------------------------------------
async function getCommitsByRepo(req, res) {
  const { repoUrl } = req.query;
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const perPageRaw = Number.parseInt(req.query.perPage, 10) || 10;
  const perPage = Math.min(Math.max(perPageRaw, 1), 100);

  if (!repoUrl) {
    return res
      .status(400)
      .json({ success: false, error: "repoUrl query param is required" });
  }

  // Parse owner/repo từ URL dạng https://github.com/owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid GitHub repo URL" });
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
        params: { per_page: perPage, page },
        timeout: 10000,
      },
    );

    const commits = response.data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      avatarUrl: c.author?.avatar_url ?? null,
    }));

    const linkHeader = response.headers?.link || "";
    const hasNextPage = /rel="next"/.test(linkHeader);
    const hasPrevPage = page > 1;

    return res.status(200).json({
      success: true,
      owner,
      repo,
      commits,
      pagination: {
        page,
        perPage,
        hasNextPage,
        hasPrevPage,
      },
    });
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
    return res
      .status(400)
      .json({ success: false, error: "siteUrl query param is required" });
  }

  try {
    const response = await axiosGetWithFallback(
      `${siteUrl}/wp-json/wp/v2/pages`,
      {
        params: { per_page: 100, _fields: "id,title,link,slug,status" },
        timeout: 15000,
      },
    );

    // Normalize page links to use the same origin as siteUrl.
    // WordPress REST API returns `link` based on its own configured siteurl,
    // which may differ from the siteUrl the browser can actually reach.
    const siteOrigin = new URL(siteUrl).origin;
    const normalizeLink = (wpLink) => {
      try {
        const parsed = new URL(wpLink);
        return siteOrigin + parsed.pathname;
      } catch {
        return siteUrl;
      }
    };

    const pages = [
      { id: 1, title: "Trang chủ", slug: "", link: siteUrl, status: "publish" },
      ...response.data.map((p) => ({
        id: p.id,
        title: p.title?.rendered ?? p.slug,
        slug: p.slug,
        link: normalizeLink(p.link),
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

// In-memory cache: siteOrigin → { cookie, expiresAt }
const WP_SESSION_CACHE = new Map();

/**
 * Lấy auth cookie từ plugin Vibepress trên WordPress.
 * Plugin tự sinh cookie cho admin — backend không cần biết password.
 * Cookie được cache cho đến khi hết hạn (plugin set 1 giờ).
 */
async function getWpAuthCookie(siteUrl, apiKey) {
  const cached = WP_SESSION_CACHE.get(siteUrl);
  // Dùng lại cache nếu còn hơn 2 phút
  if (cached && cached.expiresAt > Date.now() + 2 * 60 * 1000)
    return cached.cookie;

  try {
    const res = await axiosGetWithFallback(
      `${siteUrl}/wp-json/vibepress/v1/auth-cookie`,
      {
        headers: { "X-Vibepress-Key": apiKey },
        timeout: 15000,
      },
    );

    const { cookieName, cookieValue, expiresAt } = res.data;
    const cookie = `${cookieName}=${cookieValue}`;

    WP_SESSION_CACHE.set(siteUrl, {
      cookie,
      expiresAt: expiresAt * 1000, // plugin trả về Unix timestamp (giây)
    });

    return cookie;
  } catch (e) {
    console.warn(`[proxy] getWpAuthCookie failed for ${siteUrl}:`, e.message);
    return null;
  }
}

function logPreviewSourceContext({
  siteId,
  targetUrl,
  previewSourceContext,
}) {
  const summary = [
    `[proxy-source] siteId=${siteId || "unknown"}`,
    `url=${targetUrl}`,
    `route=${previewSourceContext.route || "/"}`,
    `template=${previewSourceContext.templateHint || "unknown"}`,
    `sourceFile=${previewSourceContext.sourceFile || "unknown"}`,
    `sourceMap=${previewSourceContext.sourceMap?.length || 0}`,
  ].join(" | ");
  console.log(summary);

  const samples = (previewSourceContext.sourceMap || []).slice(0, 5);
  samples.forEach((entry, index) => {
    console.log(
      [
        `[proxy-source] sample#${index + 1}`,
        `sourceNodeId=${entry.sourceNodeId}`,
        `block=${entry.blockName || "unknown"}`,
        `topLevelIndex=${entry.topLevelIndex}`,
        `template=${entry.templateName || "unknown"}`,
        `sourceFile=${entry.sourceFile || "unknown"}`,
      ].join(" | "),
    );
  });

  if (!samples.length) {
    console.log("[proxy-source] sample=none | exact top-level source map unavailable");
  }
}

// -------------------------------------------------------
// GET /api/wp/proxy-asset?url=<full-url>
// Proxy bất kỳ static asset (font, CSS, JS, image) từ WP với CORS headers.
// Frontend dùng: /api/wp/proxy-asset?url=http://localhost:8000/wp-content/...
// -------------------------------------------------------
async function proxyWpAsset(req, res) {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ success: false, error: "url is required" });
  }

  try {
    new URL(url); // validate
  } catch {
    return res.status(400).json({ success: false, error: "invalid url" });
  }

  try {
    const response = await axiosGetWithFallback(url, {
      timeout: 15000,
      responseType: "arraybuffer",
      maxRedirects: 5,
    });

    const contentType =
      response.headers["content-type"] || "application/octet-stream";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", contentType);
    return res.status(200).send(Buffer.from(response.data));
  } catch (e) {
    const status = e.response?.status || 502;
    return res.status(status).json({ success: false, error: e.message });
  }
}

async function proxyWpPage(req, res) {
  const { url, siteId } = req.query;

  if (!url) {
    return res
      .status(400)
      .json({ success: false, error: "url query param is required" });
  }

  try {
    const targetUrl = new URL(url);

    // Lấy auth cookie từ plugin Vibepress — plugin tự sinh, không cần password.
    // Giúp WooCommerce pages (Tài khoản, Thanh toán…) render đúng nội dung.
    const site =
      (typeof siteId === "string" && siteId
        ? await findSiteBySiteId(siteId)
        : null) || (await findSiteBySiteUrl(targetUrl.origin));
    const extraHeaders = {};
    if (site?.apiKey) {
      const authCookie = await getWpAuthCookie(targetUrl.origin, site.apiKey);
      if (authCookie) extraHeaders["Cookie"] = authCookie;
    }

    const response = await axiosGetWithFallback(url, {
      timeout: 15000,
      responseType: "text",
      maxRedirects: 5,
      headers: extraHeaders,
    });

    let html = response.data;

    // Inject <base> so relative URLs (CSS, JS, images, links) resolve to the WP origin.
    html = html.replace(
      /(<head[^>]*>)/i,
      `$1\n  <base href="${targetUrl.origin}/">`,
    );
    const previewSourceContext = await buildPreviewSourceContext({
      site,
      targetUrl: targetUrl.toString(),
      html,
    });
    logPreviewSourceContext({
      siteId:
        (typeof siteId === "string" && siteId) || site?.siteId || "",
      targetUrl: targetUrl.toString(),
      previewSourceContext,
    });
    html = injectWpPreviewMetadata(html, {
      targetUrl: targetUrl.toString(),
      siteId: typeof siteId === "string" ? siteId : "",
      templateHint: previewSourceContext.templateHint,
      sourceFile: previewSourceContext.sourceFile,
      sourceMap: previewSourceContext.sourceMap,
    });

    // Build a fresh response — intentionally omits X-Frame-Options and
    // Content-Security-Policy that WordPress/WooCommerce would send.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({
      success: false,
      error: error.message,
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
  proxyWpPage,
  proxyWpAsset,
  notifyContentChange,
  getDBinfoBySiteId,
  getSqlDumpTables,
  getSqlDumpRows,
  getSqlDumpFullTable,
  getSqlDumpAll,
  createSiteDb,
};
