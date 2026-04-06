const fs = require('fs');
const { DB_FILE } = require('../config/constants');
const { deployFullStack, pushToGit } = require('../services/deployService');

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

async function deployJob(req, res) {
  const { jobId, repoName, branch, siteId } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });

  const db = readDb();
  const site = db.wpSites?.[siteId];
  if (!site) return res.status(404).json({ error: 'No site found for this siteId' });

  const dbCreds = {
    host:     site.dbInfo?.db_host?.split(':')[0] ?? 'localhost',
    port:     site.dbInfo?.db_port ?? 3306,
    user:     site.dbInfo?.db_user,
    password: site.dbInfo?.db_password,
    dbName:   site.dbInfo?.db_name,
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
