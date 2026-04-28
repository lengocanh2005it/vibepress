const { query, queryOne } = require('../db/mysql');

async function createMigration(req, res) {
  const { site_id, job_id } = req.body;
  console.log(`[Migration] POST /migrations body=`, req.body);

  if (!site_id || !job_id) {
    console.warn(`[Migration] createMigration: thiếu site_id hoặc job_id`);
    return res.status(400).json({ error: 'site_id và job_id là bắt buộc' });
  }

  try {
    const result = await query(
      `INSERT INTO react_migrations (site_id, job_id) VALUES (?, ?)`,
      [site_id, job_id],
    );
    const migration = await queryOne('SELECT * FROM react_migrations WHERE id = ?', [result.insertId]);
    console.log(`[Migration] Đã tạo migration id=${result.insertId} site=${site_id} job=${job_id}`);
    return res.status(201).json(migration);
  } catch (err) {
    console.error(`[Migration] createMigration lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi lưu migration', detail: err.message });
  }
}

async function updateMigration(req, res) {
  const { id } = req.params;
  const { github_repo_url, deployed_url, thumbnail_url } = req.body;
  console.log(`[Migration] PATCH /migrations/${id} body=`, req.body);

  try {
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
    console.log(`[Migration] Đã cập nhật migration id=${id}`);
    return res.json(updated);
  } catch (err) {
    console.error(`[Migration] updateMigration lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi cập nhật migration', detail: err.message });
  }
}

async function getAllMigrations(req, res) {
  try {
    const migrations = await query(
      `SELECT rm.*, s.site_name, s.site_url
       FROM react_migrations rm
       LEFT JOIN wp_sites s ON s.site_id = rm.site_id
       ORDER BY rm.created_at DESC`,
    );
    return res.json(migrations);
  } catch (err) {
    console.error(`[Migration] getAllMigrations lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi lấy danh sách migration', detail: err.message });
  }
}

async function getMigrationsBySite(req, res) {
  const { siteId } = req.params;
  try {
    const migrations = await query(
      'SELECT * FROM react_migrations WHERE site_id = ? ORDER BY created_at DESC',
      [siteId],
    );
    return res.json(migrations);
  } catch (err) {
    console.error(`[Migration] getMigrationsBySite lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi lấy migrations theo site', detail: err.message });
  }
}

async function getMigrationById(req, res) {
  const { id } = req.params;
  try {
    const migration = await queryOne('SELECT * FROM react_migrations WHERE id = ?', [id]);
    if (!migration) return res.status(404).json({ error: 'Không tìm thấy migration' });
    return res.json(migration);
  } catch (err) {
    console.error(`[Migration] getMigrationById lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi lấy migration', detail: err.message });
  }
}

async function deleteMigration(req, res) {
  const { id } = req.params;
  try {
    const migration = await queryOne('SELECT id FROM react_migrations WHERE id = ?', [id]);
    if (!migration) return res.status(404).json({ error: 'Không tìm thấy migration' });

    await query('DELETE FROM react_migrations WHERE id = ?', [id]);
    console.log(`[Migration] Đã xóa migration id=${id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[Migration] deleteMigration lỗi:`, err);
    return res.status(500).json({ error: 'Lỗi khi xóa migration', detail: err.message });
  }
}

module.exports = { createMigration, updateMigration, getAllMigrations, getMigrationsBySite, getMigrationById, deleteMigration };
