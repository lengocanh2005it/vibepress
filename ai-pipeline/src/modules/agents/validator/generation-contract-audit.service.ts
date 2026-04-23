import { Injectable, Logger } from '@nestjs/common';
import type { ApiBuilderResult } from '../api-builder/api-builder.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';

interface AuditWarning {
  scope: 'routing' | 'frontend-contract' | 'cross-contract';
  componentName?: string;
  message: string;
}

interface BackendRouteHandler {
  method: string;
  path: string;
  body: string;
}

interface FrontendFetchCall {
  raw: string;
  method: string;
  path: string;
  normalizedPath: string;
  queryKeys: string[];
}

@Injectable()
export class GenerationContractAuditService {
  private readonly logger = new Logger(GenerationContractAuditService.name);

  audit(input: {
    components: GeneratedComponent[];
    plan?: PlanResult;
    api?: ApiBuilderResult | null;
  }): AuditWarning[] {
    const { components, plan, api } = input;
    const warnings: AuditWarning[] = [];
    const pageComponents = components.filter(
      (component) =>
        !component.isSubComponent && !this.isPartialComponent(component),
    );

    warnings.push(...this.auditDuplicateRoutes(pageComponents, plan));

    const backendHandlers = api
      ? api.files.flatMap((file) => this.extractBackendHandlers(file.code))
      : [];

    for (const component of components) {
      warnings.push(
        ...this.auditComponentFrontendContract(component, plan),
        ...this.auditComponentVsBackend(component, backendHandlers),
      );
    }

    return warnings;
  }

  logWarnings(warnings: AuditWarning[], prefix = 'Contract Audit'): void {
    if (warnings.length === 0) {
      this.logger.log(`[${prefix}] No deterministic contract warnings`);
      return;
    }

    this.logger.warn(
      `[${prefix}] ${warnings.length} deterministic warning(s) found`,
    );
    for (const warning of warnings) {
      const scope = warning.scope.toUpperCase();
      const target = warning.componentName ? `"${warning.componentName}" ` : '';
      this.logger.warn(`[${prefix}] [${scope}] ${target}${warning.message}`);
    }
  }

  private auditDuplicateRoutes(
    components: GeneratedComponent[],
    plan?: PlanResult,
  ): AuditWarning[] {
    const routeOwners = new Map<string, string[]>();
    for (const component of components) {
      const route =
        plan?.find((item) => item.componentName === component.name)?.route ??
        component.route ??
        null;
      if (!route) continue;
      const owners = routeOwners.get(route) ?? [];
      owners.push(component.name);
      routeOwners.set(route, owners);
    }

    const warnings: AuditWarning[] = [];
    for (const [route, owners] of routeOwners.entries()) {
      if (owners.length < 2) continue;
      warnings.push({
        scope: 'routing',
        message: `Duplicate page route "${route}" is claimed by: ${owners.join(', ')}. Preview builder will only keep the first route owner unless normalized earlier.`,
      });
    }
    return warnings;
  }

  private auditComponentFrontendContract(
    component: GeneratedComponent,
    plan?: PlanResult,
  ): AuditWarning[] {
    const warnings: AuditWarning[] = [];
    const contract = plan?.find(
      (item) => item.componentName === component.name,
    );
    const dataNeeds = new Set(
      (contract?.dataNeeds ?? component.dataNeeds ?? []).map((need) =>
        this.normalizeDataNeed(need),
      ),
    );
    const fetches = this.extractFrontendFetches(component.code);

    const hasFetch = (predicate: (fetch: FrontendFetchCall) => boolean) =>
      fetches.some(predicate);

    if (
      dataNeeds.has('posts') &&
      !hasFetch((fetch) => fetch.path === '/api/posts')
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `posts` but generated code does not fetch `/api/posts`.',
      });
    }
    if (
      dataNeeds.has('pages') &&
      !hasFetch((fetch) => fetch.path === '/api/pages')
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `pages` but generated code does not fetch `/api/pages`.',
      });
    }
    if (
      dataNeeds.has('siteInfo') &&
      !hasFetch((fetch) => fetch.path === '/api/site-info')
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `siteInfo` but generated code does not fetch `/api/site-info`.',
      });
    }
    if (
      dataNeeds.has('menus') &&
      !hasFetch((fetch) => fetch.path === '/api/menus')
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `menus` but generated code does not fetch `/api/menus`.',
      });
    }
    if (
      dataNeeds.has('footerLinks') &&
      !hasFetch((fetch) => fetch.path === '/api/footer-links')
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `footerLinks` but generated code does not fetch `/api/footer-links`.',
      });
    }
    if (
      dataNeeds.has('postDetail') &&
      !hasFetch((fetch) => /^\/api\/posts\/:param$/.test(fetch.normalizedPath))
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `postDetail` but generated code does not fetch `/api/posts/${slug}`.',
      });
    }
    if (
      dataNeeds.has('pageDetail') &&
      !hasFetch((fetch) => /^\/api\/pages\/:param$/.test(fetch.normalizedPath))
    ) {
      warnings.push({
        scope: 'frontend-contract',
        componentName: component.name,
        message:
          'Plan declares `pageDetail` but generated code does not fetch `/api/pages/${slug}`.',
      });
    }

    for (const fetch of fetches) {
      if (
        fetch.path === '/api/posts' &&
        !dataNeeds.has('posts') &&
        !dataNeeds.has('authorDetail')
      ) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Generated code fetches `/api/posts` but the plan does not declare `posts` or `authorDetail`.',
        });
      }
      if (fetch.path === '/api/pages' && !dataNeeds.has('pages')) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Generated code fetches `/api/pages` but the plan does not declare `pages`.',
        });
      }
      if (fetch.path === '/api/menus' && !dataNeeds.has('menus')) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Generated code fetches `/api/menus` but the plan does not declare `menus`.',
        });
      }
      if (fetch.path === '/api/site-info' && !dataNeeds.has('siteInfo')) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Generated code fetches `/api/site-info` but the plan does not declare `siteInfo`.',
        });
      }
      if (
        fetch.path === '/api/footer-links' &&
        !dataNeeds.has('footerLinks')
      ) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Generated code fetches `/api/footer-links` but the plan does not declare `footerLinks`.',
        });
      }
    }

    const route = contract?.route ?? component.route ?? null;
    const isArchiveAlias =
      component.name === 'Archive' ||
      route === '/archive' ||
      route === '/category/:slug' ||
      route === '/author/:slug' ||
      route === '/tag/:slug';
    if (isArchiveAlias) {
      const hasArchiveRouteDetection =
        /archiveType/.test(component.code) &&
        /location\.pathname\.startsWith\('\/category\/'/.test(component.code);
      if (!hasArchiveRouteDetection) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Archive fallback does not appear to detect alias routes like `/category/:slug`, `/author/:slug`, and `/tag/:slug`; it may behave like a generic `/archive` page only.',
        });
      }

      const hasCategoryHeading =
        /Category:/.test(component.code) ||
        /archiveType\s*===\s*['"]category['"]/.test(component.code);
      if (!hasCategoryHeading) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Archive fallback does not appear to render a category-specific heading such as `Category: <term>` for `/category/:slug` routes.',
        });
      }

      const hasArchiveSpecificFetch =
        fetches.some((fetch) =>
          /^\/api\/taxonomies\/category\/:param\/posts$/.test(
            fetch.normalizedPath,
          ),
        ) ||
        fetches.some(
          (fetch) =>
            /^\/api\/posts$/.test(fetch.normalizedPath) &&
            fetch.queryKeys.includes('author'),
        ) ||
        fetches.some((fetch) =>
          /^\/api\/taxonomies\/post_tag\/:param\/posts$/.test(
            fetch.normalizedPath,
          ),
        );
      if (!hasArchiveSpecificFetch) {
        warnings.push({
          scope: 'frontend-contract',
          componentName: component.name,
          message:
            'Archive fallback does not appear to fetch archive-specific endpoints for category/author/tag aliases; it may be using only the generic posts list.',
        });
      }
    }

    return this.dedupeWarnings(warnings);
  }

  private auditComponentVsBackend(
    component: GeneratedComponent,
    backendHandlers: BackendRouteHandler[],
  ): AuditWarning[] {
    if (backendHandlers.length === 0) return [];

    const warnings: AuditWarning[] = [];
    const fetches = this.extractFrontendFetches(component.code);

    for (const fetch of fetches) {
      const handler = backendHandlers.find(
        (candidate) =>
          candidate.method === fetch.method &&
          this.routeMatches(candidate.path, fetch.normalizedPath),
      );

      if (!handler) {
        warnings.push({
          scope: 'cross-contract',
          componentName: component.name,
          message: `Frontend fetch \`${fetch.raw}\` does not match any generated backend ${fetch.method} route.`,
        });
        continue;
      }

      for (const queryKey of fetch.queryKeys) {
        if (this.backendHandlerSupportsQuery(handler, queryKey)) continue;
        warnings.push({
          scope: 'cross-contract',
          componentName: component.name,
          message: `Frontend fetch \`${fetch.raw}\` uses query param "${queryKey}" but backend route "${handler.path}" does not appear to read it.`,
        });
      }
    }

    return this.dedupeWarnings(warnings);
  }

  private extractFrontendFetches(code: string): FrontendFetchCall[] {
    const fetches: FrontendFetchCall[] = [];
    const regex =
      /fetch\(\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")([\s\S]{0,220})\)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(code)) !== null) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!raw.startsWith('/api/')) continue;
      const normalizedRaw = raw.replace(/\$\{[^}]+\}/g, ':param');
      const [path, query = ''] = normalizedRaw.split('?');
      const queryKeys = query
        .split('&')
        .map((part) => part.split('=')[0]?.trim())
        .filter((value): value is string => Boolean(value));
      const methodMatch = match[4]?.match(
        /method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i,
      );
      fetches.push({
        raw,
        method: (methodMatch?.[1] ?? 'GET').toUpperCase(),
        path,
        normalizedPath: path,
        queryKeys,
      });
    }

    return fetches;
  }

  private extractBackendHandlers(code: string): BackendRouteHandler[] {
    const handlers: BackendRouteHandler[] = [];
    const regex = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
    const matches = [...code.matchAll(regex)];

    for (let index = 0; index < matches.length; index++) {
      const current = matches[index];
      const start = current.index ?? 0;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? code.length)
          : code.length;
      handlers.push({
        method: current[1].toUpperCase(),
        path: current[2],
        body: code.slice(start, end),
      });
    }

    return handlers;
  }

  private backendHandlerSupportsQuery(
    handler: BackendRouteHandler,
    queryKey: string,
  ): boolean {
    const escapedKey = queryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`req\\.query\\.${escapedKey}\\b`).test(handler.body)) {
      return true;
    }

    if (['page', 'perPage'].includes(queryKey)) {
      return /parsePostsPaginationQuery\(req\)/.test(handler.body);
    }

    return false;
  }

  private routeMatches(routePattern: string, fetchPath: string): boolean {
    const pattern = routePattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+');
    return new RegExp(`^${pattern}$`).test(fetchPath);
  }

  private normalizeDataNeed(value: string): string {
    switch (value) {
      case 'post-detail':
        return 'postDetail';
      case 'page-detail':
        return 'pageDetail';
      case 'site-info':
        return 'siteInfo';
      case 'footer-links':
        return 'footerLinks';
      default:
        return value;
    }
  }

  private isPartialComponent(component: GeneratedComponent): boolean {
    return (
      component.type === 'partial' ||
      component.isSubComponent === true ||
      isPartialComponentName(component.name)
    );
  }

  private dedupeWarnings(warnings: AuditWarning[]): AuditWarning[] {
    const seen = new Set<string>();
    return warnings.filter((warning) => {
      const key = `${warning.scope}|${warning.componentName ?? ''}|${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
