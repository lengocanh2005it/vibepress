import { Module } from '@nestjs/common';
import { DbContentService } from './db-content.service.js';
import { SqlModule } from '../../sql/sql.module.js';

@Module({
  imports: [SqlModule],
  providers: [DbContentService],
  exports: [DbContentService],
})
export class DbContentModule {}
