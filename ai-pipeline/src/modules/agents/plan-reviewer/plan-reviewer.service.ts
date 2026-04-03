import { Injectable, Logger } from '@nestjs/common';
import type { ComponentPlan, PlanResult } from '../planner/planner.service.js';
import type {
  ComponentVisualPlan,
  DataNeed as VisualDataNeed,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';

export interface PlanReviewResult {
  plan: PlanResult;
  warnings: string[];
  errors: string[];
  isValid: boolean;
}

type PlanDataNeed =
  | 'posts'
  | 'pages'
  | 'menus'
  | 'site-info'
  | 'post-detail'
  | 'page-detail'
  | 'authorDetail'
  | 'categoryDetail';

interface RoutePolicy {
  type: 'page' | 'partial';
  route: string | null;
  routeMode: 'hard' | 'soft';
  isDetail: boolean;
  requiredDataNeeds: PlanDataNeed[];
}

const PARTIAL_PATTERNS =
  /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)(?:[-_].+)?$/i;
const VALID_DATA_NEEDS = new Set<PlanDataNeed>([
  'posts',
  'pages',
  'menus',
  'site-info',
  'post-detail',
  'page-detail',
  'authorDetail',
  'categoryDetail',
]);

// Templates injected deterministically by the planner for standard WordPress
// archive routes — they will not appear in the raw theme template list.
const STANDARD_INJECTABLE_TEMPLATES = new Set(['author', 'category']);

@Injectable()
export class PlanReviewerService {
  private readonly logger = new Logger(PlanReviewerService.name);

  review(plan: PlanResult, expectedTemplateNames: string[]): PlanReviewResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    let reviewed = [...plan];

    reviewed = this.resolveDuplicateHomePages(reviewed, warnings);
    reviewed = this.normalizeComponentNames(reviewed, warnings);
    reviewed = this.fixTypeRouteInconsistencies(reviewed, warnings);
    reviewed = this.alignHomeHierarchyRoutes(reviewed, warnings);
    reviewed = this.alignRouteSemantics(reviewed, warnings);
    reviewed = this.alignDataNeeds(reviewed, warnings);
    reviewed = this.fixDuplicateRoutes(reviewed, warnings);
    this.checkVisualPlanCoverage(reviewed, warnings);
    this.validateHard(reviewed, expectedTemplateNames, errors);

    const pages = reviewed.filter((c) => c.type === 'page').length;
    const partials = reviewed.filter((c) => c.type === 'partial').length;
    const withVisualPlan = reviewed.filter((c) => c.visualPlan).length;

    this.logger.log(
      `Plan review: ${reviewed.length} components (${pages} pages, ${partials} partials), ${withVisualPlan}/${reviewed.length} with visual plans`,
    );

    if (errors.length > 0) {
      this.logger.error(`${errors.length} hard error(s) — plan is invalid:`);
      errors.forEach((e) => this.logger.error(`  ✗ ${e}`));
    }
    // Normalizations (duplicate home templates, visualPlan sync, etc.) — not failures.
    if (warnings.length > 0) {
      this.logger.log(
        `Plan review applied ${warnings.length} routine adjustment(s):`,
      );
      warnings.forEach((w) => this.logger.log(`  • ${w}`));
    }
    if (errors.length === 0 && warnings.length === 0) {
      this.logger.log('Plan review passed ✓');
    }

    return { plan: reviewed, warnings, errors, isValid: errors.length === 0 };
  }

  private normalizeComponentNames(
    plan: PlanResult,
    warnings: string[],
  ): PlanResult {
    const used = new Set<string>();

    return plan.map((item) => {
      const deterministic = this.toComponentName(item.templateName);
      let componentName = this.isValidComponentName(item.componentName)
        ? item.componentName
        : deterministic;

      if (componentName !== item.componentName) {
        warnings.push(
          `Component name "${item.componentName}" for template "${item.templateName}" was invalid → renamed to "${componentName}"`,
        );
      }

      if (used.has(componentName)) {
        const base = deterministic || 'Component';
        let suffix = 2;
        let candidate = `${base}${suffix}`;
        while (used.has(candidate)) {
          suffix++;
          candidate = `${base}${suffix}`;
        }
        warnings.push(
          `Duplicate component name "${componentName}" for template "${item.templateName}" → renamed to "${candidate}"`,
        );
        componentName = candidate;
      }

      used.add(componentName);
      return { ...item, componentName };
    });
  }

  private fixTypeRouteInconsistencies(
    plan: PlanResult,
    warnings: string[],
  ): PlanResult {
    return plan.map((item) => {
      const policy = this.inferRoutePolicy(item);
      let next = item;

      // Don't un-demote templates that resolveDuplicateHomePages intentionally
      // set to partial (front-page/home/index priority resolution).
      const templateBase = next.templateName
        .replace(/\.(php|html)$/i, '')
        .toLowerCase();
      const isDemotedHomeTemplate =
        /^(front-page|home|index)$/.test(templateBase) &&
        next.type === 'partial' &&
        policy.type === 'page';

      if (!isDemotedHomeTemplate && next.type !== policy.type) {
        warnings.push(
          `Template "${next.templateName}" had type "${next.type}" → normalized to "${policy.type}"`,
        );
        next = { ...next, type: policy.type };
      }

      if (next.type === 'partial') {
        const detailNeeds = next.dataNeeds.filter(
          (need) => need === 'post-detail' || need === 'page-detail',
        );
        if (next.route !== null) {
          warnings.push(
            `Partial "${next.componentName}" had route "${next.route}" → cleared`,
          );
          next = { ...next, route: null };
        }
        if (next.isDetail) {
          warnings.push(
            `Partial "${next.componentName}" had isDetail=true → set to false`,
          );
          next = { ...next, isDetail: false };
        }
        if (detailNeeds.length > 0) {
          warnings.push(
            `Partial "${next.componentName}" had detail dataNeeds (${detailNeeds.join(', ')}) → removed`,
          );
          next = {
            ...next,
            dataNeeds: next.dataNeeds.filter(
              (need) => need !== 'post-detail' && need !== 'page-detail',
            ),
          };
        }
      }

      return next;
    });
  }

  private alignRouteSemantics(
    plan: PlanResult,
    warnings: string[],
  ): PlanResult {
    return plan.map((item) => {
      const policy = this.inferRoutePolicy(item);
      let next = item;

      if (policy.routeMode === 'hard') {
        if (next.route !== policy.route) {
          warnings.push(
            `Template "${next.templateName}" route "${next.route ?? 'null'}" → normalized to "${policy.route ?? 'null'}"`,
          );
          next = { ...next, route: policy.route };
        }
      } else if (next.type === 'page' && !next.route) {
        warnings.push(
          `Page "${next.componentName}" missing route → assigned "${policy.route}"`,
        );
        next = { ...next, route: policy.route };
      }

      if (next.isDetail !== policy.isDetail) {
        warnings.push(
          `Template "${next.templateName}" had isDetail=${String(next.isDetail)} → normalized to ${String(policy.isDetail)}`,
        );
        next = { ...next, isDetail: policy.isDetail };
      }

      if (
        next.type === 'page' &&
        next.route &&
        next.route.includes(':slug') &&
        !next.isDetail
      ) {
        warnings.push(
          `Page "${next.componentName}" uses slug param route "${next.route}" → set isDetail=true`,
        );
        next = { ...next, isDetail: true };
      }

      return next;
    });
  }

  private alignDataNeeds(plan: PlanResult, warnings: string[]): PlanResult {
    // When the plan has a shared Header or Footer partial, page components must
    // NOT include their own navbar/footer sections (Layout wrapper handles them).
    const hasSharedLayout = plan.some(
      (c) =>
        c.type === 'partial' && /^(header|footer)/i.test(c.componentName),
    );

    return plan.map((item) => {
      const policy = this.inferRoutePolicy(item);
      const normalized = item.dataNeeds.filter((need): need is PlanDataNeed =>
        VALID_DATA_NEEDS.has(need as PlanDataNeed),
      );
      const needs = new Set<PlanDataNeed>(normalized);
      const before = [...needs];

      if (policy.type === 'partial') {
        needs.delete('post-detail');
        needs.delete('page-detail');
      }

      for (const need of policy.requiredDataNeeds) {
        needs.add(need);
      }

      if (
        item.route?.startsWith('/category/') ||
        item.route?.startsWith('/tag/') ||
        item.route?.startsWith('/author/')
      ) {
        needs.add('posts');
      }

      if (
        item.route === '/blog' ||
        item.route === '/archive' ||
        item.route === '/search'
      ) {
        needs.add('posts');
      }

      if (needs.has('post-detail') && needs.has('page-detail')) {
        // Resolve conflict using policy — keep whichever the template requires
        if (policy.requiredDataNeeds.includes('page-detail')) {
          needs.delete('post-detail');
        } else {
          needs.delete('page-detail');
        }
      }

      const after = this.orderPlanDataNeeds([...needs]);
      if (!this.haveSameMembers(before, after)) {
        warnings.push(
          `Template "${item.templateName}" dataNeeds [${before.join(', ')}] → [${after.join(', ')}]`,
        );
      }

      const next = { ...item, dataNeeds: after };
      return this.syncVisualPlan(next, warnings, hasSharedLayout);
    });
  }

  private syncVisualPlan(
    item: PlanResult[number],
    warnings: string[],
    hasSharedLayout: boolean = false,
  ): PlanResult[number] {
    if (!item.visualPlan) return item;

    const allowedPostDetail =
      item.isDetail === true && item.dataNeeds.includes('post-detail');
    const allowedPageDetail =
      item.isDetail === true && item.dataNeeds.includes('page-detail');
    // Strip navbar/footer sections from page components when Layout wrapper manages them
    const stripLayoutSections = hasSharedLayout && item.type === 'page';
    const nextSections = item.visualPlan.sections.filter((section) =>
      this.isSectionAllowed(
        section,
        allowedPostDetail,
        allowedPageDetail,
        stripLayoutSections,
      ),
    );
    const nextDataNeeds = this.toVisualDataNeeds(item.dataNeeds);

    const sectionsChanged =
      nextSections.length !== item.visualPlan.sections.length ||
      nextSections.some(
        (section, index) => section !== item.visualPlan!.sections[index],
      );
    const dataNeedsChanged = !this.haveSameMembers(
      item.visualPlan.dataNeeds,
      nextDataNeeds,
    );

    if (!sectionsChanged && !dataNeedsChanged) {
      return item;
    }

    if (sectionsChanged) {
      warnings.push(
        `Template "${item.templateName}" visualPlan sections were synchronized to match route/detail contract`,
      );
    }
    if (dataNeedsChanged) {
      warnings.push(
        `Template "${item.templateName}" visualPlan dataNeeds [${item.visualPlan.dataNeeds.join(', ')}] → [${nextDataNeeds.join(', ')}]`,
      );
    }

    const visualPlan: ComponentVisualPlan = {
      ...item.visualPlan,
      dataNeeds: nextDataNeeds,
      sections: nextSections,
    };
    return { ...item, visualPlan };
  }

  private isSectionAllowed(
    section: SectionPlan,
    allowedPostDetail: boolean,
    allowedPageDetail: boolean,
    stripLayoutSections: boolean = false,
  ): boolean {
    // When a shared Layout wrapper provides Header/Footer, page components must
    // not render their own navbar or footer (would appear twice on screen).
    if (stripLayoutSections && (section.type === 'navbar' || section.type === 'footer')) {
      return false;
    }
    if (section.type === 'post-content' || section.type === 'comments') {
      return allowedPostDetail;
    }
    if (section.type === 'page-content') {
      return allowedPageDetail;
    }
    return true;
  }

  private toVisualDataNeeds(dataNeeds: string[]): VisualDataNeed[] {
    const mapped = new Set<VisualDataNeed>();
    for (const need of dataNeeds) {
      switch (need) {
        case 'site-info':
          mapped.add('siteInfo');
          break;
        case 'post-detail':
          mapped.add('postDetail');
          break;
        case 'page-detail':
          mapped.add('pageDetail');
          break;
        case 'posts':
        case 'pages':
        case 'menus':
          mapped.add(need);
          break;
      }
    }
    return this.orderVisualDataNeeds([...mapped]);
  }

  private fixDuplicateRoutes(plan: PlanResult, warnings: string[]): PlanResult {
    const routeCount = new Map<string, number>();
    for (const item of plan) {
      if (item.route) {
        routeCount.set(item.route, (routeCount.get(item.route) ?? 0) + 1);
      }
    }

    const allRoutes = new Set(
      plan.map((item) => item.route).filter(Boolean) as string[],
    );
    const seen = new Map<string, number>();

    return plan.map((item) => {
      if (!item.route || item.type !== 'page') return item;
      if ((routeCount.get(item.route) ?? 0) <= 1) return item;

      const count = seen.get(item.route) ?? 0;
      seen.set(item.route, count + 1);
      if (count === 0) return item;

      const baseSlug = this.toKebabCase(
        item.templateName.replace(/\.(php|html)$/i, ''),
      );
      const routeWithSlug = item.route.includes(':slug');
      let newRoute = routeWithSlug ? `/${baseSlug}/:slug` : `/${baseSlug}`;

      let suffix = count + 1;
      while (allRoutes.has(newRoute)) {
        newRoute = routeWithSlug
          ? `/${baseSlug}-${suffix}/:slug`
          : `/${baseSlug}-${suffix}`;
        suffix++;
      }

      allRoutes.add(newRoute);
      warnings.push(
        `Duplicate route "${item.route}" on "${item.componentName}" → renamed to "${newRoute}"`,
      );
      return { ...item, route: newRoute, isDetail: newRoute.includes(':slug') };
    });
  }

  private checkVisualPlanCoverage(plan: PlanResult, warnings: string[]): void {
    const missing = plan
      .filter((c) => !c.visualPlan)
      .map((c) => c.componentName);
    if (missing.length > 0) {
      warnings.push(
        `${missing.length} component(s) without visual plan (generator will use fallback AI): ${missing.join(', ')}`,
      );
    }
  }

  private validateHard(
    plan: PlanResult,
    expectedTemplateNames: string[],
    errors: string[],
  ): void {
    if (plan.length === 0) {
      errors.push('Plan is empty — no components were generated');
      return;
    }

    const expected = new Set(expectedTemplateNames);
    const templateCounts = new Map<string, number>();
    const componentCounts = new Map<string, number>();
    const pageRoutes = new Map<string, string[]>();

    for (const item of plan) {
      const policy = this.inferRoutePolicy(item);
      templateCounts.set(
        item.templateName,
        (templateCounts.get(item.templateName) ?? 0) + 1,
      );
      componentCounts.set(
        item.componentName,
        (componentCounts.get(item.componentName) ?? 0) + 1,
      );

      if (
        !expected.has(item.templateName) &&
        !STANDARD_INJECTABLE_TEMPLATES.has(item.templateName)
      ) {
        errors.push(
          `Unexpected template in plan: "${item.templateName}" is not present in normalized theme input`,
        );
      }

      if (!this.isValidComponentName(item.componentName)) {
        errors.push(
          `Invalid component name "${item.componentName}" for template "${item.templateName}"`,
        );
      }

      if (item.type === 'partial' && item.route !== null) {
        errors.push(
          `Partial "${item.componentName}" must not have a route (got "${item.route}")`,
        );
      }

      if (item.type === 'page') {
        if (!item.route) {
          errors.push(`Page "${item.componentName}" is missing a route`);
        } else if (!this.isValidRoute(item.route)) {
          errors.push(
            `Page "${item.componentName}" has invalid route "${item.route}"`,
          );
        } else {
          const owners = pageRoutes.get(item.route) ?? [];
          owners.push(item.componentName);
          pageRoutes.set(item.route, owners);
        }
      }

      if (item.route?.includes(':slug') && !item.isDetail) {
        errors.push(
          `Page "${item.componentName}" uses route "${item.route}" with slug param but isDetail=false`,
        );
      }

      for (const need of policy.requiredDataNeeds) {
        if (!item.dataNeeds.includes(need)) {
          errors.push(
            `Component "${item.componentName}" is missing required dataNeed "${need}"`,
          );
        }
      }
    }

    for (const templateName of expectedTemplateNames) {
      // Standard injectable templates are added by the planner, not the theme — skip missing check.
      if (
        !templateCounts.has(templateName) &&
        !STANDARD_INJECTABLE_TEMPLATES.has(templateName)
      ) {
        errors.push(`Missing template in plan: "${templateName}"`);
      }
    }

    for (const [templateName, count] of templateCounts) {
      if (count > 1) {
        errors.push(
          `Template "${templateName}" appears ${count} times in plan (must be exactly once)`,
        );
      }
    }

    for (const [componentName, count] of componentCounts) {
      if (count > 1) {
        errors.push(
          `Component name "${componentName}" appears ${count} times in plan (must be unique)`,
        );
      }
    }

    for (const [route, owners] of pageRoutes) {
      if (owners.length > 1) {
        errors.push(
          `Duplicate page route "${route}" is used by: ${owners.join(', ')}`,
        );
      }
    }

    const pages = plan.filter((c) => c.type === 'page');
    if (pages.length === 0) {
      errors.push(
        `Plan has no page components (${plan.length} partial(s) only) — at least one page is required`,
      );
    }
  }

  private resolveDuplicateHomePages(
    plan: PlanResult,
    warnings: string[],
  ): PlanResult {
    // WordPress hierarchy: front-page > home > index.
    // Keep the highest-priority home-like template first so duplicate-route
    // resolution later preserves "/" for the correct winner.
    const HOME_PRIORITY = ['front-page', 'home', 'index'];

    const homeItems = plan
      .map((item) => ({
        item,
        base: item.templateName.replace(/\.(php|html)$/i, '').toLowerCase(),
      }))
      .filter(({ base }) => HOME_PRIORITY.includes(base))
      .sort(
        (a, b) => HOME_PRIORITY.indexOf(a.base) - HOME_PRIORITY.indexOf(b.base),
      );

    if (homeItems.length <= 1) return plan;

    const winner = homeItems[0];
    warnings.push(
      `Multiple home-like templates detected — prioritizing "${winner.base}" for route "/" and reassigning lower-priority routes later`,
    );

    const rank = new Map(
      HOME_PRIORITY.map((name, index) => [name, index] as const),
    );

    return [...plan].sort((a, b) => {
      const aBase = a.templateName.replace(/\.(php|html)$/i, '').toLowerCase();
      const bBase = b.templateName.replace(/\.(php|html)$/i, '').toLowerCase();
      const aRank = rank.get(aBase);
      const bRank = rank.get(bBase);
      if (aRank == null && bRank == null) return 0;
      if (aRank == null) return 1;
      if (bRank == null) return -1;
      return aRank - bRank;
    });
  }

  private alignHomeHierarchyRoutes(
    plan: PlanResult,
    warnings: string[],
  ): PlanResult {
    const byBase = new Map<
      string,
      { route: string; type: 'page'; isDetail: false }
    >();

    const hasFrontPage = plan.some((item) =>
      /^front-page$/i.test(item.templateName.replace(/\.(php|html)$/i, '')),
    );
    const hasHome = plan.some((item) =>
      /^home$/i.test(item.templateName.replace(/\.(php|html)$/i, '')),
    );
    const hasIndex = plan.some((item) =>
      /^index$/i.test(item.templateName.replace(/\.(php|html)$/i, '')),
    );

    if (hasFrontPage) {
      byBase.set('front-page', { route: '/', type: 'page', isDetail: false });
      if (hasHome) {
        byBase.set('home', { route: '/blog', type: 'page', isDetail: false });
      }
      if (hasIndex) {
        byBase.set('index', {
          route: '/index',
          type: 'page',
          isDetail: false,
        });
      }
    } else if (hasHome) {
      byBase.set('home', { route: '/', type: 'page', isDetail: false });
      if (hasIndex) {
        byBase.set('index', {
          route: '/index',
          type: 'page',
          isDetail: false,
        });
      }
    } else if (hasIndex) {
      byBase.set('index', { route: '/', type: 'page', isDetail: false });
    }

    if (byBase.size === 0) return plan;

    return plan.map((item) => {
      const base = item.templateName
        .replace(/\.(php|html)$/i, '')
        .toLowerCase();
      const expected = byBase.get(base);
      if (!expected) return item;

      let next = item;
      if (next.type !== expected.type) {
        warnings.push(
          `Template "${next.templateName}" had type "${next.type}" → normalized to "${expected.type}" by home hierarchy`,
        );
        next = { ...next, type: expected.type };
      }
      if (next.route !== expected.route) {
        warnings.push(
          `Template "${next.templateName}" route "${next.route ?? 'null'}" → normalized to "${expected.route}" by home hierarchy`,
        );
        next = { ...next, route: expected.route };
      }
      if (next.isDetail !== expected.isDetail) {
        warnings.push(
          `Template "${next.templateName}" had isDetail=${String(next.isDetail)} → normalized to false by home hierarchy`,
        );
        next = { ...next, isDetail: false };
      }
      return next;
    });
  }

  private inferRoutePolicy(item: ComponentPlan): RoutePolicy {
    const templateBase = item.templateName
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
    const routeSlug = this.toKebabCase(templateBase);

    if (PARTIAL_PATTERNS.test(templateBase)) {
      return {
        type: 'partial',
        route: null,
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: [],
      };
    }

    if (/^(front-page|home|index)$/.test(templateBase)) {
      return {
        type: 'page',
        route: item.route ?? '/',
        routeMode: 'soft',
        isDetail: false,
        requiredDataNeeds: [],
      };
    }

    if (/^404$/.test(templateBase)) {
      return {
        type: 'page',
        route: '*',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: [],
      };
    }

    if (/^search$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/search',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^archive$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/archive',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^blog$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/blog',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^category(?:-.+)?$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/category/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^tag(?:-.+)?$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/tag/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^author(?:-.+)?$/.test(templateBase)) {
      return {
        type: 'page',
        route: '/author/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['posts'],
      };
    }

    if (/^single(?:-.+)?$/.test(templateBase)) {
      return {
        type: 'page',
        route:
          templateBase === 'single' || templateBase === 'single-post'
            ? '/post/:slug'
            : `/${routeSlug}/:slug`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['post-detail'],
      };
    }

    if (/^page(?:-.+)?$/.test(templateBase)) {
      return {
        type: 'page',
        route: templateBase === 'page' ? '/page/:slug' : `/${routeSlug}/:slug`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['page-detail'],
      };
    }

    return {
      type: 'page',
      route: `/${routeSlug}`,
      routeMode: 'soft',
      isDetail: false,
      requiredDataNeeds: [],
    };
  }

  private isValidComponentName(name: string): boolean {
    return /^[A-Z][A-Za-z0-9]*$/.test(name);
  }

  private isValidRoute(route: string): boolean {
    return route === '*' || route.startsWith('/');
  }

  private toComponentName(templateName: string): string {
    const name = templateName
      .replace(/\.(php|html)$/i, '')
      .split(/[\\/_-]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }

  private toKebabCase(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }

  private orderPlanDataNeeds(dataNeeds: PlanDataNeed[]): PlanDataNeed[] {
    const order: PlanDataNeed[] = [
      'post-detail',
      'page-detail',
      'posts',
      'pages',
      'menus',
      'site-info',
    ];
    return order.filter((need) => dataNeeds.includes(need));
  }

  private orderVisualDataNeeds(dataNeeds: VisualDataNeed[]): VisualDataNeed[] {
    const order: VisualDataNeed[] = [
      'postDetail',
      'pageDetail',
      'posts',
      'pages',
      'menus',
      'siteInfo',
    ];
    return order.filter((need) => dataNeeds.includes(need));
  }

  private haveSameMembers(valuesA: string[], valuesB: string[]): boolean {
    if (valuesA.length !== valuesB.length) return false;
    const sortedA = [...valuesA].sort();
    const sortedB = [...valuesB].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
  }
}
