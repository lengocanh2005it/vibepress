import { Module } from '@nestjs/common';
import { DbContentService } from './db-content.service.js';
import { SqlModule } from '../../sql/sql.module.js';
import { PluginDiscoveryModule } from '../plugin-discovery/plugin-discovery.module.js';

@Module({
  imports: [SqlModule, PluginDiscoveryModule],
  providers: [DbContentService],
  exports: [DbContentService],
})
export class DbContentModule {}
