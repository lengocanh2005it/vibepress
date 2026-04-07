import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mysql2/promise';
import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { parseDbConnectionString } from '../../common/utils/db-connection-parser.js';

@Injectable()
export class SqlService {
  private readonly logger = new Logger(SqlService.name);

  constructor(private readonly configService: ConfigService) {}

  // Mode A: Import file .sql vào DB tạm, trả về connection string để shared với React app
  async importToTempDb(filePath: string, jobId: string): Promise<string> {
    const short = jobId.replace(/-/g, '').slice(0, 12);
    const dbName = `wp_${short}`;
    const dbUser = `u_${short}`;
    const dbPassword = randomBytes(16).toString('hex');
    const host = this.configService.get<string>('db.host')!;
    const port = this.configService.get<number>('db.port')!;

    const conn = await this.createAdminConnection();
    try {
      this.logger.log(`Creating shared DB: ${dbName} / user: ${dbUser}`);

      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      await conn.query(
        `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}'`,
      );
      await conn.query(
        `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%'`,
      );
      await conn.query(`FLUSH PRIVILEGES`);
      await conn.query(`USE \`${dbName}\``);

      const sql = await readFile(filePath, 'utf-8');
      const statements = this.splitStatements(sql);
      for (const stmt of statements) {
        if (stmt.trim()) await conn.query(stmt);
      }

      this.logger.log(
        `Imported SQL into ${dbName} (${statements.length} statements)`,
      );
    } finally {
      await conn.end();
    }

    // DB giữ lại làm Shared DB cho React app — không drop sau pipeline
    return `mysql://${dbUser}:${dbPassword}@${host}:${port}/${dbName}`;
  }

  // Mode B: User cung cấp connection string trực tiếp — verify connection rồi trả về
  async verifyDirectCredentials(connectionString: string): Promise<void> {
    const creds = parseDbConnectionString(connectionString);
    const conn = await createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.database,
    });
    await conn.ping();
    await conn.end();
    this.logger.log(
      `Direct DB connection verified: ${creds.host}/${creds.database}`,
    );
  }

  // Cleanup Mode A DB khi cần (gọi thủ công, không auto-drop)
  async dropDb(connectionString: string, dbUser?: string): Promise<void> {
    const creds = parseDbConnectionString(connectionString);
    const conn = await this.createAdminConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${creds.database}\``);
      if (dbUser) {
        await conn.query(`DROP USER IF EXISTS '${dbUser}'@'%'`);
        await conn.query(`FLUSH PRIVILEGES`);
      }
      this.logger.log(`Dropped DB: ${creds.database}`);
    } finally {
      await conn.end();
    }
  }

  private async createAdminConnection() {
    return createConnection({
      host: this.configService.get<string>('db.host'),
      port: this.configService.get<number>('db.port'),
      user: this.configService.get<string>('db.user'),
      password: this.configService.get<string>('db.password'),
      multipleStatements: true,
    });
  }

  private splitStatements(sql: string): string[] {
    return sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
