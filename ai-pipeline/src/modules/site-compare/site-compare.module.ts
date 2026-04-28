import { Module } from '@nestjs/common';
import { AutomationSiteCompareProvider } from './providers/automation-site-compare.provider.js';
import { OpenClawSiteCompareProvider } from './providers/openclaw-site-compare.provider.js';
import { SiteCompareService } from './site-compare.service.js';

@Module({
  providers: [
    SiteCompareService,
    AutomationSiteCompareProvider,
    OpenClawSiteCompareProvider,
  ],
  exports: [SiteCompareService],
})
export class SiteCompareModule {}
