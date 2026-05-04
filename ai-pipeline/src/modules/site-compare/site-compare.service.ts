import { Injectable } from '@nestjs/common';
import { AutomationSiteCompareProvider } from './providers/automation-site-compare.provider.js';
import type {
  SiteCompareExecutionResult,
  SiteCompareInput,
} from './site-compare.types.js';

@Injectable()
export class SiteCompareService {
  constructor(
    private readonly automationProvider: AutomationSiteCompareProvider,
  ) {}

  async compare(input: SiteCompareInput): Promise<SiteCompareExecutionResult> {
    return {
      provider: 'automation',
      metrics: await this.automationProvider.compare(input),
    };
  }
}
