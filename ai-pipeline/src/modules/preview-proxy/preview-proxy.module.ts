import { Module } from '@nestjs/common';
import { PreviewProxyController } from './preview-proxy.controller.js';

@Module({
  controllers: [PreviewProxyController],
})
export class PreviewProxyModule {}
