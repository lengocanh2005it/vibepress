import { createConnection } from 'mysql2/promise';

export async function getConn() {
  return createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wordpress',
  });
}

let cachedTablePrefix: string | null = null;

export async function getPrefix(
  conn: Awaited<ReturnType<typeof getConn>>,
): Promise<string> {
  if (cachedTablePrefix) return cachedTablePrefix;

  const [rows] = await conn.query<any[]>(
    `SELECT table_name AS tableName FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name LIKE '%options'
     ORDER BY table_name ASC`,
  );
  if (!rows.length) {
    cachedTablePrefix = 'wp_';
    return cachedTablePrefix;
  }

  const candidates = (
    await Promise.all(
      rows
        .map((row) => String(row.tableName ?? '').trim())
        .filter((tableName) => /options$/i.test(tableName))
        .map((tableName) => inspectOptionsTableCandidate(conn, tableName)),
    )
  ).filter((candidate) => candidate !== null);

  if (candidates.length === 0) {
    cachedTablePrefix = 'wp_';
    return cachedTablePrefix;
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Number(b.hasThemeMods) !== Number(a.hasThemeMods)) {
      return Number(b.hasThemeMods) - Number(a.hasThemeMods);
    }
    if (Number(b.isRootLike) !== Number(a.isRootLike)) {
      return Number(b.isRootLike) - Number(a.isRootLike);
    }
    if (a.prefix.length !== b.prefix.length) {
      return a.prefix.length - b.prefix.length;
    }
    return a.tableName.localeCompare(b.tableName);
  });

  const best = candidates[0];
  cachedTablePrefix = best?.prefix || 'wp_';

  if (candidates.length > 1 && best) {
    console.warn(
      `[DB Prefix] Selected "${best.prefix}" from "${best.tableName}" (score=${best.score}). Candidates: ${candidates
        .map(
          (candidate) =>
            `${candidate.tableName}[score=${candidate.score},stylesheet=${candidate.stylesheet || '(empty)'},template=${candidate.template || '(empty)'}]`,
        )
        .join(', ')}`,
    );
  }

  return cachedTablePrefix;
}

async function inspectOptionsTableCandidate(
  conn: Awaited<ReturnType<typeof getConn>>,
  tableName: string,
): Promise<{
  tableName: string;
  prefix: string;
  stylesheet: string;
  template: string;
  hasThemeMods: boolean;
  isRootLike: boolean;
  score: number;
} | null> {
  try {
    const prefix = tableName.replace(/options$/i, '');
    const keys = ['stylesheet', 'template', 'siteurl', 'home', 'blogname'];
    const [rows] = await conn.query<any[]>(
      `SELECT option_name, option_value FROM \`${tableName}\`
       WHERE option_name IN (${keys.map(() => '?').join(',')})`,
      keys,
    );

    const optionMap = new Map<string, string>();
    for (const row of rows) {
      optionMap.set(
        String(row.option_name ?? ''),
        String(row.option_value ?? '').trim(),
      );
    }

    const stylesheet = optionMap.get('stylesheet') ?? '';
    const template = optionMap.get('template') ?? '';
    const siteUrl = optionMap.get('siteurl') ?? '';
    const home = optionMap.get('home') ?? '';
    const blogName = optionMap.get('blogname') ?? '';
    const isRootLike = !/\d+_$/.test(prefix);

    let hasThemeMods = false;
    if (stylesheet) {
      const [[modsRow]] = await conn.query<any[]>(
        `SELECT 1 AS present FROM \`${tableName}\` WHERE option_name = ? LIMIT 1`,
        [`theme_mods_${stylesheet}`],
      );
      hasThemeMods = Boolean(modsRow?.present);
    }

    let score = 0;
    if (stylesheet) score += 6;
    if (template) score += 6;
    if (siteUrl) score += 4;
    if (home) score += 3;
    if (blogName) score += 1;
    if (hasThemeMods) score += 4;
    if (isRootLike) score += 1;
    if (stylesheet && template && stylesheet === template) score += 1;

    return {
      tableName,
      prefix,
      stylesheet,
      template,
      hasThemeMods,
      isRootLike,
      score,
    };
  } catch (error: any) {
    console.warn(
      `[DB Prefix] Failed to inspect "${tableName}": ${error?.message ?? error}`,
    );
    return null;
  }
}
