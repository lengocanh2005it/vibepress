import { Module } from '@nestjs/common';
import { SqlModule } from '../../sql/sql.module.js';
import { SourceResolverService } from './source-resolver.service.js';

@Module({
  imports: [SqlModule],
  providers: [SourceResolverService],
  exports: [SourceResolverService],
})
export class SourceResolverModule {}
