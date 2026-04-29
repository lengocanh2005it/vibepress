import { Module } from '@nestjs/common';
import { AutomationSiteCompareProvider } from './providers/automation-site-compare.provider.js';
import { SiteCompareService } from './site-compare.service.js';
import { SiteCompareVisualDiagnosisService } from './visual-diagnosis.service.js';

@Module({
  providers: [
    SiteCompareService,
    AutomationSiteCompareProvider,
    SiteCompareVisualDiagnosisService,
  ],
  exports: [SiteCompareService, SiteCompareVisualDiagnosisService],
})
export class SiteCompareModule {}
