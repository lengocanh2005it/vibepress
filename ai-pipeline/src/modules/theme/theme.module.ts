import { Module } from '@nestjs/common';
import { ThemeDetectorService } from './theme-detector.service.js';
import { ThemeService } from './theme.service.js';

@Module({
  providers: [ThemeService, ThemeDetectorService],
  exports: [ThemeService, ThemeDetectorService],
})
export class ThemeModule {}
