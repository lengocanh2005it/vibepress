import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { normalizeOpenClawCompareResult } from '../normalizers/openclaw-result.normalizer.js';
import type {
  SiteCompareInput,
  SiteCompareMetrics,
} from '../site-compare.types.js';

@Injectable()
export class OpenClawSiteCompareProvider {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async compare(
    input: SiteCompareInput,
  ): Promise<SiteCompareMetrics | undefined> {
    const openClawUrl = this.configService
      .get<string>('siteCompare.openclawUrl', '')
      .trim()
      .replace(/\/$/, '');
    if (!openClawUrl) {
      throw new Error('siteCompare.openclawUrl is empty');
    }

    const comparePath =
      this.configService.get<string>(
        'siteCompare.openclawComparePath',
        '/site/compare',
      ) ?? '/site/compare';
    const apiKey = this.configService
      .get<string>('siteCompare.openclawApiKey', '')
      .trim();
    const apiKeyHeader =
      this.configService.get<string>(
        'siteCompare.openclawApiKeyHeader',
        'Authorization',
      ) ?? 'Authorization';
    const apiKeyPrefix =
      this.configService.get<string>(
        'siteCompare.openclawApiKeyPrefix',
        'Bearer ',
      ) ?? 'Bearer ';
    const timeoutMs = Math.max(
      1000,
      this.configService.get<number>('siteCompare.openclawTimeoutMs', 120000),
    );

    const headers =
      apiKey && apiKeyHeader
        ? { [apiKeyHeader]: `${apiKeyPrefix}${apiKey}` }
        : undefined;

    const response = await lastValueFrom(
      this.httpService.post(
        `${openClawUrl}${comparePath.startsWith('/') ? comparePath : `/${comparePath}`}`,
        {
          siteId: input.siteId,
          wpSiteId: input.siteId,
          wpBaseUrl: input.wpBaseUrl,
          reactFeUrl: input.reactFeUrl,
          reactBeUrl: input.reactBeUrl,
          jobId: input.jobId,
          mode: input.mode,
          routeEntries: input.routeEntries,
        },
        {
          headers,
          timeout: timeoutMs,
        },
      ),
    );

    const normalized = normalizeOpenClawCompareResult(response.data);
    if (!normalized) {
      throw new Error(
        'OpenClaw compare did not return a recognizable metrics payload',
      );
    }

    return normalized;
  }
}
