const { deployFullStack } = require('../services/deployService');

async function deployJob(req, res) {
  const { jobId, repoName, branch, dbCreds, dbInfo } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  // Hỗ trợ cả 2 format: dbCreds (chuẩn) và dbInfo (format từ db.json)
  const resolvedDbCreds = dbCreds ?? (dbInfo ? {
    host:     dbInfo.db_host?.split(':')[0] ?? 'localhost',
    port:     dbInfo.db_port ?? 3306,
    user:     dbInfo.db_user,
    password: dbInfo.db_password,
    dbName:   dbInfo.db_name,
  } : null);

  if (!resolvedDbCreds) return res.status(400).json({ error: 'dbCreds or dbInfo is required' });

  try {
    const result = await deployFullStack({ jobId, repoName, branch, dbCreds: resolvedDbCreds });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { deployJob };
