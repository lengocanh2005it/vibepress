const { randomUUID } = require('crypto');
const { query, queryOne } = require('../db/mysql');

async function createMigration(req, res) {
  const { site_id, job_id } = req.body;

  if (!site_id || !job_id) {
    return res.status(400).json({ error: 'site_id và job_id là bắt buộc' });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO react_migrations (id, site_id, job_id)
     VALUES (?, ?, ?)`,
    [id, site_id, job_id],
  );

  const migration = await queryOne('SELECT * FROM react_migrations WHERE id = ?', [id]);
  return res.status(201).json(migration);
}

async function updateMigration(req, res) {
  const { id } = req.params;
  const { github_repo_url, deployed_url, thumbnail_url } = req.body;

  const migration = await queryOne('SELECT id FROM react_migrations WHERE id = ?', [id]);
  if (!migration) return res.status(404).json({ error: 'Không tìm thấy migration' });

  const fields = [];
  const values = [];

  if (github_repo_url !== undefined) { fields.push('github_repo_url = ?'); values.push(github_repo_url); }
  if (deployed_url !== undefined)    { fields.push('deployed_url = ?');    values.push(deployed_url); }
  if (thumbnail_url !== undefined)   { fields.push('thumbnail_url = ?');   values.push(thumbnail_url); }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'Không có trường nào để cập nhật' });
  }

  values.push(id);
  await query(`UPDATE react_migrations SET ${fields.join(', ')} WHERE id = ?`, values);

  const updated = await queryOne('SELECT * FROM react_migrations WHERE id = ?', [id]);
  return res.json(updated);
}

async function getMigrationsBySite(req, res) {
  const { siteId } = req.params;
  const migrations = await query(
    'SELECT * FROM react_migrations WHERE site_id = ? ORDER BY created_at DESC',
    [siteId],
  );
  return res.json(migrations);
}

async function getMigrationById(req, res) {
  const { id } = req.params;
  const migration = await queryOne('SELECT * FROM react_migrations WHERE id = ?', [id]);
  if (!migration) return res.status(404).json({ error: 'Không tìm thấy migration' });
  return res.json(migration);
}

async function deleteMigration(req, res) {
  const { id } = req.params;
  const migration = await queryOne('SELECT id FROM react_migrations WHERE id = ?', [id]);
  if (!migration) return res.status(404).json({ error: 'Không tìm thấy migration' });

  await query('DELETE FROM react_migrations WHERE id = ?', [id]);
  return res.json({ success: true });
}

module.exports = { createMigration, updateMigration, getMigrationsBySite, getMigrationById, deleteMigration };
