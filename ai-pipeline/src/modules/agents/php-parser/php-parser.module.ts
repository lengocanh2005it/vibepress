import { Module } from '@nestjs/common';
import { PhpParserService } from './php-parser.service.js';

@Module({
  providers: [PhpParserService],
  exports: [PhpParserService],
})
export class PhpParserModule {}
