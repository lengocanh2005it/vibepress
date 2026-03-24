import { Module } from '@nestjs/common';
import { SqlService } from './sql.service.js';
import { WpQueryService } from './wp-query.service.js';

@Module({
  providers: [SqlService, WpQueryService],
  exports: [SqlService, WpQueryService],
})
export class SqlModule {}
