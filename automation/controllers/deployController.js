const { query, queryOne } = require('../db/mysql');
const { deployFullStack, pushToGit, redeployFrontend } = require('../services/deployService');

async function deployJob(req, res) {
  const { jobId, repoName, branch, siteId } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });

  const row = await queryOne('SELECT cloned_db FROM wp_sites WHERE site_id = ? LIMIT 1', [siteId]);
  if (!row) return res.status(404).json({ error: 'No site found for this siteId' });

  const clonedDb = row.cloned_db
    ? (typeof row.cloned_db === 'string' ? JSON.parse(row.cloned_db) : row.cloned_db)
    : null;

  if (!clonedDb) return res.status(400).json({ error: 'Site has no cloned database' });

  const dbCreds = {
    host:     clonedDb.host,
    port:     clonedDb.port ?? 3306,
    user:     clonedDb.user,
    password: clonedDb.password,
    dbName:   clonedDb.dbName,
  };

  try {
    const result = await deployFullStack({ jobId, repoName, branch, dbCreds });

    const migration = await queryOne('SELECT id FROM react_migrations WHERE job_id = ?', [jobId]);
    if (migration) {
      await query(
        'UPDATE react_migrations SET github_repo_url = ?, deployed_url = ? WHERE id = ?',
        [result.githubUrl, result.frontendUrl, migration.id],
      );
      console.log(`[Deploy] Migration id=${migration.id} updated with urls`);
    } else {
      console.warn(`[Deploy] Không tìm thấy migration cho job_id=${jobId}, bỏ qua update`);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function pushToGitJob(req, res) {
  const { jobId, repoName, branch } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  try {
    const result = await pushToGit({ jobId, repoName, branch });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function checkSubdomain(req, res) {
  const { subdomain } = req.query;
  if (!subdomain || typeof subdomain !== 'string' || !subdomain.trim()) {
    return res.status(400).json({ error: 'subdomain is required' });
  }
  const slug = subdomain.trim().toLowerCase();
  const row = await queryOne(
    `SELECT id FROM react_migrations
     WHERE github_repo_url LIKE CONCAT('%/', ?)
        OR deployed_url LIKE CONCAT('http://', ?, '.%')
        OR deployed_url LIKE CONCAT('https://', ?, '.%')
     LIMIT 1`,
    [slug, slug, slug],
  );
  res.json({ available: !row });
}

async function redeployJob(req, res) {
  const { jobId, siteId } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });

  const migration = await queryOne(
    'SELECT id, github_repo_url FROM react_migrations WHERE job_id = ? LIMIT 1',
    [jobId],
  );
  if (!migration?.github_repo_url) {
    return res.status(404).json({ error: 'Migration chưa được deploy lần đầu' });
  }

  const repoName = migration.github_repo_url.split('/').pop();

  try {
    const result = await redeployFrontend({ jobId, repoName });

    await query(
      'UPDATE react_migrations SET deployed_url = ? WHERE id = ?',
      [result.frontendUrl, migration.id],
    );

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { deployJob, pushToGitJob, checkSubdomain, redeployJob };
