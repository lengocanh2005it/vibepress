import { Module } from '@nestjs/common';
import { StyleResolverService } from './style-resolver.service.js';

@Module({
  providers: [StyleResolverService],
  exports: [StyleResolverService],
})
export class StyleResolverModule {}
