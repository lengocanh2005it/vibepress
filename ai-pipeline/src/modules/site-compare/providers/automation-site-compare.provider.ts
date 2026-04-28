import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import type {
  SiteCompareInput,
  SiteCompareMetrics,
} from '../site-compare.types.js';

@Injectable()
export class AutomationSiteCompareProvider {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async compare(
    input: SiteCompareInput,
  ): Promise<SiteCompareMetrics | undefined> {
    const automationUrl = this.configService
      .get<string>('automation.url', '')
      .trim()
      .replace(/\/$/, '');
    if (!automationUrl) {
      throw new Error('automation.url is empty');
    }

    const response = await lastValueFrom(
      this.httpService.post(`${automationUrl}/site/compare`, {
        siteId: input.siteId,
        wpSiteId: input.siteId,
        wpBaseUrl: input.wpBaseUrl,
        reactFeUrl: input.reactFeUrl,
        reactBeUrl: input.reactBeUrl,
      }),
    );

    return (response.data?.result ?? response.data) as
      | SiteCompareMetrics
      | undefined;
  }
}
