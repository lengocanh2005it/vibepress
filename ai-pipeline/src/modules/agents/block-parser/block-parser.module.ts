import { Module } from '@nestjs/common';
import { BlockParserService } from './block-parser.service.js';

@Module({
  providers: [BlockParserService],
  exports: [BlockParserService],
})
export class BlockParserModule {}
