import { Module } from '@nestjs/common';
import { ThemeProfileRegistry } from './profiles/theme-profile.registry.js';
import { ThemeDetectorService } from './theme-detector.service.js';
import { ThemeRepoLayoutResolverService } from './theme-repo-layout-resolver.service.js';
import { ThemeService } from './theme.service.js';

@Module({
  providers: [
    ThemeService,
    ThemeDetectorService,
    ThemeRepoLayoutResolverService,
    ThemeProfileRegistry,
  ],
  exports: [
    ThemeService,
    ThemeDetectorService,
    ThemeRepoLayoutResolverService,
    ThemeProfileRegistry,
  ],
})
export class ThemeModule {}
