import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mysql2/promise';
import { readFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export type { WpDbCredentials };

@Injectable()
export class SqlService {
  private readonly logger = new Logger(SqlService.name);

  constructor(private readonly configService: ConfigService) {}

  // Mode A: Import file .sql vào DB tạm, trả về credentials để shared với React app
  async importToTempDb(
    filePath: string,
    jobId: string,
  ): Promise<WpDbCredentials> {
    const short = jobId.replace(/-/g, '').slice(0, 12);
    const dbName = `wp_${short}`;
    const dbUser = `u_${short}`;
    const dbPassword = randomBytes(16).toString('hex');

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
    return {
      host: this.configService.get<string>('db.host')!,
      port: this.configService.get<number>('db.port')!,
      dbName,
      user: dbUser,
      password: dbPassword,
    };
  }

  // Mode B: User cung cấp credentials trực tiếp — verify connection rồi trả về
  async verifyDirectCredentials(creds: WpDbCredentials): Promise<void> {
    const conn = await createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.dbName,
    });
    await conn.ping();
    await conn.end();
    this.logger.log(
      `Direct DB connection verified: ${creds.host}/${creds.dbName}`,
    );
  }

  // Cleanup Mode A DB khi cần (gọi thủ công, không auto-drop)
  async dropDb(creds: WpDbCredentials & { dbUser?: string }): Promise<void> {
    const conn = await this.createAdminConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${creds.dbName}\``);
      if (creds.dbUser) {
        await conn.query(`DROP USER IF EXISTS '${creds.dbUser}'@'%'`);
        await conn.query(`FLUSH PRIVILEGES`);
      }
      this.logger.log(`Dropped DB: ${creds.dbName}`);
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
