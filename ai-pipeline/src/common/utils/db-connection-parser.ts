/**
 * Parses a database connection string into a standard configuration object.
 * Format: mysql://user:password@host:port/dbname
 */
export function parseDbConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1),
    };
  } catch (error) {
    throw new Error(`Invalid database connection string: ${connectionString}`);
  }
}
