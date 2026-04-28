import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutomationSiteCompareProvider } from './providers/automation-site-compare.provider.js';
import { OpenClawSiteCompareProvider } from './providers/openclaw-site-compare.provider.js';
import type {
  SiteCompareExecutionResult,
  SiteCompareFallbackProviderKind,
  SiteCompareInput,
  SiteCompareProviderKind,
} from './site-compare.types.js';

@Injectable()
export class SiteCompareService {
  private readonly logger = new Logger(SiteCompareService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly automationProvider: AutomationSiteCompareProvider,
    private readonly openClawProvider: OpenClawSiteCompareProvider,
  ) {}

  async compare(input: SiteCompareInput): Promise<SiteCompareExecutionResult> {
    const provider = this.configService.get<SiteCompareProviderKind>(
      'siteCompare.provider',
      'automation',
    );

    if (provider === 'automation') {
      return {
        provider: 'automation',
        metrics: await this.automationProvider.compare(input),
      };
    }

    if (provider === 'openclaw') {
      return this.compareWithOpenClawFallback(input);
    }

    return this.compareHybrid(input);
  }

  private async compareHybrid(
    input: SiteCompareInput,
  ): Promise<SiteCompareExecutionResult> {
    return this.compareWithOpenClawFallback(input);
  }

  private async compareWithOpenClawFallback(
    input: SiteCompareInput,
  ): Promise<SiteCompareExecutionResult> {
    const warnings: string[] = [];
    try {
      const metrics = await this.openClawProvider.compare(input);
      return {
        provider: 'openclaw',
        metrics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`OpenClaw compare failed: ${message}`);
      this.logger.warn(`[site-compare] OpenClaw compare failed: ${message}`);
    }

    const fallbackProvider =
      this.configService.get<SiteCompareFallbackProviderKind>(
        'siteCompare.fallbackProvider',
        'automation',
      );

    if (fallbackProvider !== 'automation') {
      throw new Error(
        warnings[warnings.length - 1] ?? 'OpenClaw compare failed',
      );
    }

    const metrics = await this.automationProvider.compare(input);
    return {
      provider: 'automation',
      metrics,
      warnings,
      fallbackUsed: true,
    };
  }
}
