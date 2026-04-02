import { Module } from '@nestjs/common';
import { PluginDiscoveryService } from './plugin-discovery.service.js';

@Module({
  providers: [PluginDiscoveryService],
  exports: [PluginDiscoveryService],
})
export class PluginDiscoveryModule {}
