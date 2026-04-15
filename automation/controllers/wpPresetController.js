"use strict";

const db = require("../db/mysql");

async function listPresets(req, res) {
  const rows = await db.query(
    "SELECT id, site_name, description, image_url FROM wp_presets ORDER BY created_at DESC"
  );
  return res.json({ success: true, data: rows });
}

async function getPresetById(req, res) {
  const { id } = req.params;
  const row = await db.queryOne(
    "SELECT * FROM wp_presets WHERE id = ?",
    [id]
  );
  if (!row) {
    return res.status(404).json({ success: false, message: "Preset not found" });
  }
  return res.json({ success: true, data: row });
}

module.exports = { listPresets, getPresetById };
