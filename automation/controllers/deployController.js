const { queryOne } = require('../db/mysql');
const { deployFullStack, pushToGit } = require('../services/deployService');

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

module.exports = { deployJob, pushToGitJob };
