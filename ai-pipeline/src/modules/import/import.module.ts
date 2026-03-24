import { Module } from '@nestjs/common';
import { ImportController } from './import.controller.js';
import { ImportService } from './import.service.js';
import { SqlModule } from '../sql/sql.module.js';
import { ThemeModule } from '../theme/theme.module.js';

@Module({
  imports: [SqlModule, ThemeModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
