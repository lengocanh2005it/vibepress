const fs = require('fs');
const path = require('path');

/**
 * Read a PHP define() constant value, supports both single and double quotes.
 */
function phpDefineValue(content, key) {
	const re = new RegExp(
		`define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*(?:'([^']*)'|"([^"]*)")\\s*\\)`,
	);
	const m = content.match(re);
	if (!m) return undefined;
	return m[1] !== undefined ? m[1] : m[2];
}

function extractFromWpConfig(wpSourceDir) {
	const configPath = path.join(wpSourceDir, 'wp-config.php');
	if (!fs.existsSync(configPath)) return {};

	const content = fs.readFileSync(configPath, 'utf8');
	const info = {};

	const defines = { DB_NAME: 'dbName', DB_USER: 'dbUser', DB_PASSWORD: 'dbPassword', DB_HOST: 'dbHost' };
	for (const [phpKey, jsKey] of Object.entries(defines)) {
		const val = phpDefineValue(content, phpKey);
		if (val !== undefined) info[jsKey] = val;
	}

	const prefixMatch = content.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/);
	if (prefixMatch) info.tablePrefix = prefixMatch[1];

	return info;
}

function findSqlFile(wpSourceDir) {
	// AIOWP stores the DB dump as database.sql at the archive root
	const primary = path.join(wpSourceDir, 'database.sql');
	if (fs.existsSync(primary)) return primary;

	// Fallback: any .sql file at root level
	try {
		const entries = fs.readdirSync(wpSourceDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory() && e.name.endsWith('.sql')) {
				return path.join(wpSourceDir, e.name);
			}
		}
	} catch {
		// ignore
	}

	return null;
}

function extractFromSql(wpSourceDir) {
	const sqlPath = findSqlFile(wpSourceDir);
	if (!sqlPath) return {};

	// Only read the first 2 MB - enough to find wp_options near the top
	const buf = Buffer.alloc(2 * 1024 * 1024);
	const fd = fs.openSync(sqlPath, 'r');
	const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
	fs.closeSync(fd);

	const sql = buf.subarray(0, bytesRead).toString('utf8');
	const info = {};

	const fields = [
		['siteurl', 'siteUrl'],
		['blogname', 'siteName'],
		['admin_email', 'adminEmail'],
	];

	for (const [optKey, jsKey] of fields) {
		// Matches: 'siteurl','https://example.com'
		const m = sql.match(new RegExp(`'${optKey}'\\s*,\\s*'([^']*)'`));
		if (m) info[jsKey] = m[1];
	}

	info.sqlFile = path.basename(sqlPath);
	return info;
}

/**
 * Extract WordPress DB / site information from a directory
 * that was unpacked from a .wpress archive.
 *
 * Returns an object with keys like:
 *   dbName, dbUser, dbPassword, dbHost, tablePrefix,
 *   siteUrl, siteName, adminEmail, sqlFile
 */
function extractDbInfo(wpSourceDir) {
	const configInfo = extractFromWpConfig(wpSourceDir);
	const sqlInfo = extractFromSql(wpSourceDir);
	return { ...configInfo, ...sqlInfo };
}

module.exports = { extractDbInfo };
