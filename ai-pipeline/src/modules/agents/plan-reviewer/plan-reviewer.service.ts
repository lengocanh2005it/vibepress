import { Injectable, Logger } from '@nestjs/common';
import type { ComponentPlan, PlanResult } from '../planner/planner.service.js';
import type {
  ComponentVisualPlan,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';
import { sanitizeSectionsForContract } from '../react-generator/prompts/visual-plan.prompt.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import { toVisualDataNeeds } from '../shared/visual-data-needs.util.js';
import {
  buildRepoRouteHints,
  HOME_TEMPLATE_PRIORITY,
  inferDeterministicRouteContract,
  resolveHomeHierarchy,
  type DeterministicRouteContract,
  type RouteContractDataNeed,
  toHomeTemplateBase,
} from '../planner/route-contract.util.js';

export interface PlanReviewResult {
  plan: PlanResult;
  expectedTemplateNames: string[];
  warnings: string[];
  warningCodes: PlanReviewWarningCode[];
  errors: string[];
  isValid: boolean;
}

export type PlanReviewWarningCode =
  | 'template_part_enforced_partial'
  | 'invalid_component_name_normalized'
  | 'duplicate_component_name_normalized'
  | 'type_normalized'
  | 'partial_route_cleared'
  | 'partial_is_detail_cleared'
  | 'partial_detail_dataneeds_removed'
  | 'route_normalized'
  | 'missing_page_route_assigned'
  | 'detail_flag_normalized'
  | 'page_level_chrome_dataneeds_removed'
  | 'template_dataneeds_normalized'
  | 'visualplan_sections_synchronized'
  | 'visualplan_contract_sanitized'
  | 'visualplan_dataneeds_synchronized'
  | 'duplicate_route_normalized'
  | 'missing_visual_plan_fallback_ai'
  | 'multiple_home_like_templates_detected'
  | 'redundant_home_alias_removed'
  | 'home_hierarchy_type_normalized'
  | 'home_hierarchy_route_normalized'
  | 'home_hierarchy_is_detail_normalized';

type PlanDataNeed = RouteContractDataNeed;
type RoutePolicy = DeterministicRouteContract;

const VALID_DATA_NEEDS = new Set<PlanDataNeed>([
  'posts',
  'products',
  'pages',
  'menus',
  'site-info',
  'footer-links',
  'post-detail',
  'product-detail',
  'page-detail',
  'comments',
  'categoryDetail',
]);

// Templates injected deterministically by the planner for standard WordPress
// archive routes — they will not appear in the raw theme template list.
const STANDARD_INJECTABLE_TEMPLATES = new Set(['author', 'category']);
const HOME_TEMPLATE_PRIORITY_SET = new Set<string>(HOME_TEMPLATE_PRIORITY);

function toTemplateBase(templateName: string): string {
  return templateName.replace(/\.(php|html)$/i, '').toLowerCase();
}

@Injectable()
export class PlanReviewerService {
  private readonly logger = new Logger(PlanReviewerService.name);

  review(
    plan: PlanResult,
    expectedTemplateNames: string[],
    repoManifest?: RepoThemeManifest,
  ): PlanReviewResult {
    const warnings: string[] = [];
    const warningCodes: PlanReviewWarningCode[] = [];
    const errors: string[] = [];
    let reviewed = [...plan];
    let adjustedExpectedTemplateNames = [...expectedTemplateNames];

    // Pre-pass: enforce partial type for template parts with known area assignments.
    // theme.json templateParts declarations are authoritative — if theme.json says
    // "header" is area:header, the component must be a partial regardless of what the AI planned.
    if (repoManifest?.themeJsonSummary.templatePartAreas.length) {
      reviewed = this.applyManifestAreaHints(
        reviewed,
        repoManifest.themeJsonSummary.templatePartAreas,
        warnings,
        warningCodes,
      );
    }

    reviewed = this.normalizeComponentNames(reviewed, warnings, warningCodes);
    ({ plan: reviewed, expectedTemplateNames: adjustedExpectedTemplateNames } =
      this.normalizeHomeHierarchy(
        reviewed,
        adjustedExpectedTemplateNames,
        repoManifest,
        warnings,
        warningCodes,
      ));
    reviewed = this.fixTypeRouteInconsistencies(
      reviewed,
      warnings,
      warningCodes,
      repoManifest,
    );
    reviewed = this.alignRouteSemantics(
      reviewed,
      warnings,
      warningCodes,
      repoManifest,
    );
    reviewed = this.alignDataNeeds(
      reviewed,
      warnings,
      warningCodes,
      reviewed,
      repoManifest,
    );
    reviewed = this.fixDuplicateRoutes(reviewed, warnings, warningCodes);
    this.checkVisualPlanCoverage(reviewed, warnings, warningCodes);
    this.validateHard(
      reviewed,
      adjustedExpectedTemplateNames,
      errors,
      repoManifest,
    );
    this.validateDraftSectionFidelity(reviewed, errors);
    this.validateDraftLiteralCoverage(reviewed, errors);

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

    return {
      plan: reviewed,
      expectedTemplateNames: adjustedExpectedTemplateNames,
      warnings,
      warningCodes,
      errors,
      isValid: errors.length === 0,
    };
  }

  private pushWarning(
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
    code: PlanReviewWarningCode,
    message: string,
  ): void {
    warnings.push(message);
    warningCodes.push(code);
  }

  private applyManifestAreaHints(
    plan: PlanResult,
    templatePartAreas: { name: string; title: string; area: string }[],
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): PlanResult {
    const knownPartials = new Set(
      templatePartAreas.map((p) => p.name.toLowerCase()),
    );
    return plan.map((item) => {
      const base = item.templateName
        .replace(/\.(php|html)$/i, '')
        .toLowerCase();
      if (!knownPartials.has(base) || item.type === 'partial') return item;
      this.pushWarning(
        warnings,
        warningCodes,
        'template_part_enforced_partial',
        `Template "${item.templateName}" is declared as a template part in theme.json → enforced as partial`,
      );
      return { ...item, type: 'partial', route: null, isDetail: false };
    });
  }

  private normalizeComponentNames(
    plan: PlanResult,
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): PlanResult {
    const used = new Set<string>();

    return plan.map((item) => {
      const deterministic = this.toComponentName(item.templateName);
      let componentName = this.isValidComponentName(item.componentName)
        ? item.componentName
        : deterministic;

      if (componentName !== item.componentName) {
        this.pushWarning(
          warnings,
          warningCodes,
          'invalid_component_name_normalized',
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
        this.pushWarning(
          warnings,
          warningCodes,
          'duplicate_component_name_normalized',
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
    warningCodes: PlanReviewWarningCode[],
    repoManifest?: RepoThemeManifest,
  ): PlanResult {
    return plan.map((item) => {
      const policy = this.inferRoutePolicy(item, plan, repoManifest);
      let next = item;

      // Home hierarchy normalization may intentionally keep a lower-priority
      // home-like template out of the page path earlier in review.
      const templateBase = toTemplateBase(next.templateName);
      const isDemotedHomeTemplate =
        HOME_TEMPLATE_PRIORITY_SET.has(templateBase) &&
        next.type === 'partial' &&
        policy.type === 'page';

      if (!isDemotedHomeTemplate && next.type !== policy.type) {
        this.pushWarning(
          warnings,
          warningCodes,
          'type_normalized',
          `Template "${next.templateName}" had type "${next.type}" → normalized to "${policy.type}"`,
        );
        next = { ...next, type: policy.type };
      }

      if (next.type === 'partial') {
        const detailNeeds = next.dataNeeds.filter(
          (need) =>
            need === 'post-detail' ||
            need === 'product-detail' ||
            need === 'page-detail',
        );
        if (next.route !== null) {
          this.pushWarning(
            warnings,
            warningCodes,
            'partial_route_cleared',
            `Partial "${next.componentName}" had route "${next.route}" → cleared`,
          );
          next = { ...next, route: null };
        }
        if (next.isDetail) {
          this.pushWarning(
            warnings,
            warningCodes,
            'partial_is_detail_cleared',
            `Partial "${next.componentName}" had isDetail=true → set to false`,
          );
          next = { ...next, isDetail: false };
        }
        if (detailNeeds.length > 0) {
          this.pushWarning(
            warnings,
            warningCodes,
            'partial_detail_dataneeds_removed',
            `Partial "${next.componentName}" had detail dataNeeds (${detailNeeds.join(', ')}) → removed`,
          );
          next = {
            ...next,
            dataNeeds: next.dataNeeds.filter(
              (need) =>
                need !== 'post-detail' &&
                need !== 'product-detail' &&
                need !== 'page-detail',
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
    warningCodes: PlanReviewWarningCode[],
    repoManifest?: RepoThemeManifest,
  ): PlanResult {
    return plan.map((item) => {
      const policy = this.inferRoutePolicy(item, plan, repoManifest);
      let next = item;

      if (policy.routeMode === 'hard') {
        if (next.route !== policy.route) {
          this.pushWarning(
            warnings,
            warningCodes,
            'route_normalized',
            `Template "${next.templateName}" route "${next.route ?? 'null'}" → normalized to "${policy.route ?? 'null'}"`,
          );
          next = { ...next, route: policy.route };
        }
      } else if (
        next.type === 'page' &&
        next.route &&
        next.route.includes(':slug') &&
        !policy.isDetail
      ) {
        const normalizedRoute = this.stripDynamicSegments(
          policy.route ?? next.route,
        );
        this.pushWarning(
          warnings,
          warningCodes,
          'route_normalized',
          `Template "${next.templateName}" route "${next.route}" → normalized to "${normalizedRoute}" because this template is not a detail route`,
        );
        next = { ...next, route: normalizedRoute };
      } else if (next.type === 'page' && !next.route) {
        this.pushWarning(
          warnings,
          warningCodes,
          'missing_page_route_assigned',
          `Page "${next.componentName}" missing route → assigned "${policy.route}"`,
        );
        next = { ...next, route: policy.route };
      }

      if (next.isDetail !== policy.isDetail) {
        this.pushWarning(
          warnings,
          warningCodes,
          'detail_flag_normalized',
          `Template "${next.templateName}" had isDetail=${String(next.isDetail)} → normalized to ${String(policy.isDetail)}`,
        );
        next = { ...next, isDetail: policy.isDetail };
      }

      return next;
    });
  }

  private stripDynamicSegments(route: string): string {
    const normalized = route.replace(/\/:[A-Za-z_][A-Za-z0-9_-]*/g, '').trim();
    return normalized || '/';
  }

  private alignDataNeeds(
    plan: PlanResult,
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
    fullPlan?: PlanResult,
    repoManifest?: RepoThemeManifest,
  ): PlanResult {
    return plan.map((item) => {
      const policy = this.inferRoutePolicy(
        item,
        fullPlan ?? plan,
        repoManifest,
      );
      const normalized = item.dataNeeds.filter((need): need is PlanDataNeed =>
        VALID_DATA_NEEDS.has(need as PlanDataNeed),
      );
      const needs = new Set<PlanDataNeed>(normalized);
      const before = [...needs];
      const templateBase = toTemplateBase(item.templateName);
      const isFooterPartial =
        policy.type === 'partial' &&
        (/^footer(?:[-_].+)?$/.test(templateBase) ||
          /^footer(?:[-_].+)?$/i.test(item.componentName));
      const isHeaderLikePartial =
        policy.type === 'partial' &&
        (/^(header|nav|navigation)(?:[-_].+)?$/.test(templateBase) ||
          /^(Header|Nav|Navigation)(?:[-_].+)?$/.test(item.componentName));

      if (policy.type === 'partial') {
        needs.delete('post-detail');
        needs.delete('product-detail');
        needs.delete('page-detail');
      }
      for (const disallowedNeed of policy.disallowedDetailDataNeeds) {
        needs.delete(disallowedNeed);
      }

      for (const need of policy.requiredDataNeeds) {
        needs.add(need);
      }

      if (isFooterPartial) {
        needs.add('site-info');
        needs.add('footer-links');
        needs.delete('menus');
      }
      if (isHeaderLikePartial) {
        needs.delete('footer-links');
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

      if (policy.type === 'page') {
        const removedChromeNeeds: PlanDataNeed[] = [];
        if (needs.delete('menus')) removedChromeNeeds.push('menus');
        if (needs.delete('site-info')) removedChromeNeeds.push('site-info');
        if (needs.delete('footer-links'))
          removedChromeNeeds.push('footer-links');
        if (removedChromeNeeds.length > 0) {
          this.pushWarning(
            warnings,
            warningCodes,
            'page_level_chrome_dataneeds_removed',
            `Template "${item.templateName}" removed page-level chrome dataNeeds (${removedChromeNeeds.join(', ')}) because shared layout partials own global chrome`,
          );
        }
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
        this.pushWarning(
          warnings,
          warningCodes,
          'template_dataneeds_normalized',
          `Template "${item.templateName}" dataNeeds [${before.join(', ')}] → [${after.join(', ')}]`,
        );
      }

      const next = { ...item, dataNeeds: after };
      return this.syncVisualPlan(next, warnings, warningCodes);
    });
  }

  private syncVisualPlan(
    item: PlanResult[number],
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): PlanResult[number] {
    if (!item.visualPlan) return item;

    const allowedPostDetail =
      item.isDetail === true && item.dataNeeds.includes('post-detail');
    const allowedPageDetail =
      item.isDetail === true && item.dataNeeds.includes('page-detail');
    const stripLayoutSections = item.type === 'page';
    const filteredSections = item.visualPlan.sections.filter((section) =>
      this.isSectionAllowed(
        section,
        allowedPostDetail,
        allowedPageDetail,
        stripLayoutSections,
      ),
    );
    const nextDataNeeds = toVisualDataNeeds(item.dataNeeds);
    const sanitizedSections = sanitizeSectionsForContract(filteredSections, {
      componentType: item.type,
      route: item.route,
      isDetail: item.isDetail,
      dataNeeds: nextDataNeeds,
      stripLayoutChrome: item.type === 'page',
      sourceBackedAuxiliaryLabels: item.sourceBackedAuxiliaryLabels,
    });
    const nextSections = this.normalizePostDetailSections(
      item,
      this.normalizeFixedPageDetailSections(
        item,
        sanitizedSections.sections,
        sanitizedSections.adjustments,
      ),
      sanitizedSections.adjustments,
    );

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
      this.pushWarning(
        warnings,
        warningCodes,
        'visualplan_sections_synchronized',
        `Template "${item.templateName}" visualPlan sections were synchronized to match route/detail contract`,
      );
    }
    if (sanitizedSections.adjustments.length > 0) {
      this.pushWarning(
        warnings,
        warningCodes,
        'visualplan_contract_sanitized',
        `Template "${item.templateName}" visualPlan contract sanitization: ${sanitizedSections.adjustments.join('; ')}`,
      );
    }
    if (dataNeedsChanged) {
      this.pushWarning(
        warnings,
        warningCodes,
        'visualplan_dataneeds_synchronized',
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
    // Page components must not render their own navbar or footer; global chrome
    // belongs to the shared Layout/partial layer, not route components.
    if (
      stripLayoutSections &&
      (section.type === 'navbar' || section.type === 'footer')
    ) {
      return false;
    }
    if (section.type === 'post-content' || section.type === 'comments') {
      return allowedPostDetail;
    }
    if (section.type === 'page-content' || section.type === 'prose-block') {
      return allowedPageDetail;
    }
    // For detail pages, hero/cover sections from the draft are layout
    // placeholders that the AI replaces with post-content or page-content.
    // Enforcing them as required sections causes false type-mismatch failures.
    if (
      (section.type === 'hero' || section.type === 'cover') &&
      (allowedPostDetail || allowedPageDetail)
    ) {
      return false;
    }
    return true;
  }

  private fixDuplicateRoutes(
    plan: PlanResult,
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): PlanResult {
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
      this.pushWarning(
        warnings,
        warningCodes,
        'duplicate_route_normalized',
        `Duplicate route "${item.route}" on "${item.componentName}" → renamed to "${newRoute}"`,
      );
      return { ...item, route: newRoute, isDetail: newRoute.includes(':slug') };
    });
  }

  private checkVisualPlanCoverage(
    plan: PlanResult,
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): void {
    const missing = plan
      .filter((c) => !c.visualPlan && c.runtimeRenderer !== 'runtime-page')
      .map((c) => c.componentName);
    if (missing.length > 0) {
      this.pushWarning(
        warnings,
        warningCodes,
        'missing_visual_plan_fallback_ai',
        `${missing.length} component(s) without visual plan (generator will use fallback AI): ${missing.join(', ')}`,
      );
    }
  }

  private validateHard(
    plan: PlanResult,
    expectedTemplateNames: string[],
    errors: string[],
    repoManifest?: RepoThemeManifest,
  ): void {
    if (plan.length === 0) {
      errors.push('Plan is empty — no components were generated');
      return;
    }

    const expected = new Set(expectedTemplateNames);
    const templateCounts = new Map<string, number>();
    const templateItems = new Map<string, ComponentPlan[]>();
    const componentCounts = new Map<string, number>();
    const pageRoutes = new Map<string, string[]>();

    for (const item of plan) {
      const policy = this.inferRoutePolicy(item, plan, repoManifest);
      templateCounts.set(
        item.templateName,
        (templateCounts.get(item.templateName) ?? 0) + 1,
      );
      const existingTemplateItems = templateItems.get(item.templateName) ?? [];
      existingTemplateItems.push(item);
      templateItems.set(item.templateName, existingTemplateItems);
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
      const items = templateItems.get(templateName) ?? [];
      if (
        count > 1 &&
        !this.allowsConcreteTemplateMultiplicity(templateName, items)
      ) {
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

  private validateDraftSectionFidelity(
    plan: PlanResult,
    errors: string[],
  ): void {
    for (const item of plan) {
      const expectedDraftSections = this.getContractExpectedDraftSections(item);
      if (expectedDraftSections.length === 0) continue;

      if (!item.visualPlan) {
        // Missing visual plan is non-fatal: the generator falls back to the D3
        // AI path using draftSections as context.
        this.logger.warn(
          `Component "${item.componentName}" has no visualPlan despite ${expectedDraftSections.length} draft section(s) — generator will use D3 fallback`,
        );
        continue;
      }

      const actualSections = item.visualPlan.sections;

      // Reject AI-added orphan sections (no sourceRef) that exceed the draft count.
      // These are hallucinated sections with no WP source backing.
      const orphans = actualSections.filter(
        (s, i) =>
          i >= expectedDraftSections.length &&
          !s.sourceRef?.sourceNodeId &&
          !this.isAllowedOrphanSection(item, s, actualSections),
      );
      for (const orphan of orphans) {
        errors.push(
          `Component "${item.componentName}" has AI-added orphan section [${orphan.type}] debugKey="${orphan.debugKey ?? orphan.sectionKey ?? 'undefined'}" with no sourceRef — remove it`,
        );
      }

      for (let index = 0; index < expectedDraftSections.length; index++) {
        const expectedSection = expectedDraftSections[index];
        const actualSection = actualSections[index];
        const expectedLabel = this.describeSectionIdentity(expectedSection);

        if (!actualSection) {
          errors.push(
            `Component "${item.componentName}" is missing draft-backed section ${index + 1} (${expectedLabel})`,
          );
          continue;
        }

        if (actualSection.type !== expectedSection.type) {
          // Interactive section types (modal, carousel, tabs, accordion) should
          // only be assigned when the source block is a native interactive block.
          // Substituting a plain core/group to modal/carousel is AI hallucination
          // — reject and restore the draft type + content to prevent fabricated UIs.
          const interactiveTypes = [
            'modal',
            'carousel',
            'tabs',
            'accordion',
          ] as const;
          const nativeInteractiveBlocks = [
            'uagb/modal',
            'uagb/popup',
            'uagb/slider',
            'uagb/tabs',
            'uagb/faq',
            'uagb/content-toggle',
          ];
          const actualIsInteractive = (
            interactiveTypes as readonly string[]
          ).includes(actualSection.type);
          const sourceIsNativeInteractive = nativeInteractiveBlocks.includes(
            expectedSection.sourceRef?.blockName ?? '',
          );
          if (
            sourceIsNativeInteractive &&
            actualSection.type !== expectedSection.type
          ) {
            errors.push(
              `Component "${item.componentName}" section ${index + 1} lost native interactive widget fidelity: draft "${expectedSection.type}" (blockName="${expectedSection.sourceRef?.blockName ?? 'unknown'}") → actual "${actualSection.type}" — preserve the source-backed interactive section type instead of flattening it.`,
            );
          } else if (actualIsInteractive && !sourceIsNativeInteractive) {
            errors.push(
              `Component "${item.componentName}" section ${index + 1} illegal type substitution: draft "${expectedSection.type}" (blockName="${expectedSection.sourceRef?.blockName ?? 'unknown'}") → actual "${actualSection.type}" — source block is not a native interactive widget; rejecting to prevent hallucinated UI`,
            );
          } else {
            // Semantic substitutions (search, comments, post-list, hero) are
            // allowed. Warn but don't block.
            this.logger.warn(
              `Component "${item.componentName}" section ${index + 1} type substitution: draft "${expectedSection.type}" → actual "${actualSection.type}"`,
            );
          }
        }

        if (
          expectedSection.sourceRef?.sourceNodeId &&
          actualSection.sourceRef?.sourceNodeId !==
            expectedSection.sourceRef.sourceNodeId
        ) {
          errors.push(
            `Component "${item.componentName}" section ${index + 1} lost sourceNodeId "${expectedSection.sourceRef.sourceNodeId}"`,
          );
        }
      }
    }
  }

  private getContractExpectedDraftSections(
    item: PlanResult[number],
  ): SectionPlan[] {
    if (!item.draftSections?.length) return [];
    const allowedPostDetail =
      item.isDetail === true && item.dataNeeds.includes('post-detail');
    const allowedPageDetail =
      item.isDetail === true && item.dataNeeds.includes('page-detail');
    const stripLayoutSections = item.type === 'page';
    const filteredSections = item.draftSections.filter((section) =>
      this.isSectionAllowed(
        section,
        allowedPostDetail,
        allowedPageDetail,
        stripLayoutSections,
      ),
    );
    const sanitizedSections = sanitizeSectionsForContract(filteredSections, {
      componentType: item.type,
      route: item.route,
      isDetail: item.isDetail,
      dataNeeds: toVisualDataNeeds(item.dataNeeds),
      stripLayoutChrome: item.type === 'page',
      sourceBackedAuxiliaryLabels: item.sourceBackedAuxiliaryLabels,
    });
    return this.normalizePostDetailSections(
      item,
      this.normalizeFixedPageDetailSections(item, sanitizedSections.sections),
    );
  }

  private normalizeFixedPageDetailSections(
    item: PlanResult[number],
    sections: SectionPlan[],
    adjustments?: string[],
  ): SectionPlan[] {
    const isFixedPageDetail =
      item.type === 'page' &&
      item.isDetail === true &&
      !!item.fixedSlug &&
      item.dataNeeds.includes('page-detail');
    if (!isFixedPageDetail) return sections;

    if (sections.length > 0) return sections;

    adjustments?.push(
      'inserted canonical page-content wrapper for fixed page-detail because no valid sections remained after sanitization',
    );

    return [
      {
        type: 'page-content',
        showTitle: !/no.?title/i.test(item.componentName),
      },
    ];
  }

  private normalizePostDetailSections(
    item: PlanResult[number],
    sections: SectionPlan[],
    adjustments?: string[],
  ): SectionPlan[] {
    const isPostDetail =
      item.type === 'page' &&
      item.isDetail === true &&
      item.dataNeeds.includes('post-detail');
    if (!isPostDetail) return sections;

    const templateBase = toTemplateBase(item.templateName);
    const hasSidebarLayout =
      /sidebar/.test(templateBase) ||
      /withsidebar|sidebar/i.test(item.componentName);
    const hasMainContent = sections.some(
      (section) => section.type === 'post-content',
    );
    const hasComments = sections.some((section) => section.type === 'comments');
    const hasSidebar = sections.some((section) => section.type === 'sidebar');
    const hasSidebarAuxiliarySections = sections.some((section) =>
      ['search', 'card-grid', 'breadcrumb'].includes(section.type),
    );
    const hasOnlyAuxiliarySections =
      sections.length > 0 &&
      sections.every((section) =>
        ['search', 'card-grid', 'hero', 'cover', 'breadcrumb'].includes(
          section.type,
        ),
      );

    if (!hasMainContent && !hasOnlyAuxiliarySections) return sections;

    const canonicalSections: SectionPlan[] = [
      {
        type: 'post-content',
        showTitle: !/no.?title/i.test(item.componentName),
        showAuthor: false,
        showDate: false,
        showCategories: false,
      },
    ];

    if (item.dataNeeds.includes('comments')) {
      canonicalSections.push({
        type: 'comments',
        showForm: true,
        requireName: true,
        requireEmail: false,
      });
    }

    if (hasSidebarLayout) {
      canonicalSections.splice(1, 0, {
        type: 'sidebar',
        title: 'Explore',
        widgets: [
          { kind: 'pages-list', title: 'Pages' },
          { kind: 'recent-posts', title: 'Recent Posts' },
        ],
        maxItems: 8,
      });
    }

    if (!hasMainContent) {
      adjustments?.push(
        'replaced auxiliary-only post-detail sections with canonical post-content layout',
      );
      return canonicalSections;
    }

    const nextSections =
      hasSidebarLayout && !hasSidebar && hasSidebarAuxiliarySections
        ? sections.filter(
            (section) =>
              !['search', 'card-grid', 'breadcrumb'].includes(section.type),
          )
        : [...sections];
    if (hasSidebarLayout && !hasSidebar && hasSidebarAuxiliarySections) {
      adjustments?.push(
        'collapsed sidebar auxiliary widgets into canonical sidebar section for post-detail layout',
      );
    }
    if (item.dataNeeds.includes('comments') && !hasComments) {
      nextSections.push({
        type: 'comments',
        showForm: true,
        requireName: true,
        requireEmail: false,
      });
      adjustments?.push(
        'inserted canonical comments section for post-detail because comments dataNeed was missing from visual sections',
      );
    }
    if (hasSidebarLayout && !hasSidebar) {
      nextSections.push({
        type: 'sidebar',
        title: 'Explore',
        widgets: [
          { kind: 'pages-list', title: 'Pages' },
          { kind: 'recent-posts', title: 'Recent Posts' },
        ],
        maxItems: 8,
      });
      adjustments?.push(
        'inserted canonical sidebar section for sidebar post-detail because no sidebar section remained after sanitization',
      );
    }
    return nextSections;
  }

  private describeSectionIdentity(section: SectionPlan): string {
    return [
      section.type,
      (section.debugKey ?? section.sectionKey)
        ? `debugKey=${section.debugKey ?? section.sectionKey}`
        : null,
      section.sourceRef?.sourceNodeId
        ? `sourceNodeId=${section.sourceRef.sourceNodeId}`
        : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  private isAllowedOrphanSection(
    item: PlanResult[number],
    orphan: SectionPlan,
    actualSections: SectionPlan[],
  ): boolean {
    const templateBase = toTemplateBase(item.templateName);

    // 404 pages may legitimately add one search section even when the source
    // draft only produced a hero/message block. Keep this exception narrow so
    // other AI-added orphan sections still fail hard.
    if (
      templateBase === '404' &&
      item.route === '*' &&
      orphan.type === 'search' &&
      actualSections.filter((section) => section.type === 'search').length === 1
    ) {
      return true;
    }

    return false;
  }

  private normalizeHomeHierarchy(
    plan: PlanResult,
    expectedTemplateNames: string[],
    repoManifest: RepoThemeManifest | undefined,
    warnings: string[],
    warningCodes: PlanReviewWarningCode[],
  ): { plan: PlanResult; expectedTemplateNames: string[] } {
    const homeItems = plan
      .map((item) => ({
        item,
        base: toHomeTemplateBase(item.templateName),
      }))
      .filter(
        (
          entry,
        ): entry is {
          item: PlanResult[number];
          base: NonNullable<ReturnType<typeof toHomeTemplateBase>>;
        } => !!entry.base,
      );

    const explicitTemplateNames = plan
      .filter((item) => {
        const base = toHomeTemplateBase(item.templateName);
        if (!base) return false;
        const sourceFile = String(item.planningSourceFile ?? '').toLowerCase();
        const sourceLabel = String(
          item.planningSourceLabel ?? '',
        ).toLowerCase();
        return (
          sourceFile.endsWith(`/${base}`) ||
          sourceLabel.endsWith(`:${base}`) ||
          sourceLabel.endsWith(`/${base}`)
        );
      })
      .map((item) => item.templateName);

    const homeHierarchy = resolveHomeHierarchy({
      templateNames: [
        ...expectedTemplateNames,
        ...plan.map((item) => item.templateName),
      ],
      repoManifest,
      explicitTemplateNames,
    });

    if (homeItems.length > 1 && homeHierarchy.winnerBase) {
      this.pushWarning(
        warnings,
        warningCodes,
        'multiple_home_like_templates_detected',
        `Multiple home-like templates detected — prioritizing "${homeHierarchy.winnerBase}" for route "/" and reassigning lower-priority routes later`,
      );
    }

    const redundantBases = new Set(homeHierarchy.redundantBases);
    let nextPlan = plan;
    let nextExpectedTemplateNames = expectedTemplateNames.filter(
      (templateName) => {
        const base = toHomeTemplateBase(templateName);
        return !base || !redundantBases.has(base);
      },
    );

    if (redundantBases.has('home')) {
      const homeItem = nextPlan.find(
        (item) => toTemplateBase(item.templateName) === 'home',
      );
      const indexItem = nextPlan.find(
        (item) => toTemplateBase(item.templateName) === 'index',
      );

      nextPlan = nextPlan
        .map((item) => {
          if (
            !homeItem ||
            !indexItem ||
            item.templateName !== indexItem.templateName
          ) {
            return item;
          }
          return {
            ...item,
            dataNeeds: Array.from(
              new Set([
                ...(item.dataNeeds ?? []),
                ...(homeItem.dataNeeds ?? []),
              ]),
            ),
            description: homeItem.description?.trim() || item.description,
          };
        })
        .filter((item) => toTemplateBase(item.templateName) !== 'home');

      this.pushWarning(
        warnings,
        warningCodes,
        'redundant_home_alias_removed',
        `Template "home" removed because it has no dedicated source and only aliases "index"`,
      );
    }

    const orderRank = new Map(
      homeHierarchy.orderedTemplateNames.map((templateName, index) => [
        templateName,
        index,
      ]),
    );
    nextPlan = [...nextPlan].sort((left, right) => {
      const leftRank = orderRank.get(left.templateName);
      const rightRank = orderRank.get(right.templateName);
      if (leftRank == null && rightRank == null) return 0;
      if (leftRank == null) return 1;
      if (rightRank == null) return -1;
      return leftRank - rightRank;
    });

    nextPlan = nextPlan.map((item) => {
      const base = toHomeTemplateBase(item.templateName);
      const expectedRoute = base ? homeHierarchy.routeByBase[base] : undefined;
      if (!base || !expectedRoute) return item;

      let next = item;
      if (next.type !== 'page') {
        this.pushWarning(
          warnings,
          warningCodes,
          'home_hierarchy_type_normalized',
          `Template "${next.templateName}" had type "${next.type}" → normalized to "page" by home hierarchy`,
        );
        next = { ...next, type: 'page' };
      }
      if (next.route !== expectedRoute) {
        this.pushWarning(
          warnings,
          warningCodes,
          'home_hierarchy_route_normalized',
          `Template "${next.templateName}" route "${next.route ?? 'null'}" → normalized to "${expectedRoute}" by home hierarchy`,
        );
        next = { ...next, route: expectedRoute };
      }
      if (next.isDetail) {
        this.pushWarning(
          warnings,
          warningCodes,
          'home_hierarchy_is_detail_normalized',
          `Template "${next.templateName}" had isDetail=${String(next.isDetail)} → normalized to false by home hierarchy`,
        );
        next = { ...next, isDetail: false };
      }
      return next;
    });

    nextExpectedTemplateNames = resolveHomeHierarchy({
      templateNames: nextExpectedTemplateNames,
      repoManifest,
      explicitTemplateNames,
    }).orderedTemplateNames;

    return {
      plan: nextPlan,
      expectedTemplateNames: nextExpectedTemplateNames,
    };
  }

  private inferRoutePolicy(
    item: ComponentPlan,
    plan?: PlanResult,
    repoManifest?: RepoThemeManifest,
  ): RoutePolicy {
    const hasConcretePageBindings =
      item.runtimeRenderer === 'runtime-page' ||
      (!!plan &&
        item.type === 'page' &&
        !item.fixedSlug &&
        item.dataNeeds.includes('page-detail') &&
        plan.some(
          (candidate) =>
            candidate !== item &&
            candidate.templateName === item.templateName &&
            candidate.type === 'page' &&
            candidate.isDetail === true &&
            !!candidate.fixedSlug &&
            candidate.dataNeeds.includes('page-detail'),
        ));

    return inferDeterministicRouteContract({
      templateName: item.templateName,
      componentName: item.componentName,
      type: item.type,
      route: item.route,
      dataNeeds: item.dataNeeds,
      isDetail: item.isDetail,
      fixedSlug: item.fixedSlug,
      fixedPageId: item.fixedPageId,
      draftBlockTree: item.draftBlockTree,
      renderContract: item.renderContract,
      planningSourceFile: item.planningSourceFile,
      planningSourceLabel: item.planningSourceLabel,
      planningSourceSummary: item.planningSourceSummary,
      hasConcretePageBindings,
      repoRouteHints: buildRepoRouteHints(item.templateName, repoManifest),
    });
  }

  private allowsConcreteTemplateMultiplicity(
    templateName: string,
    items: ComponentPlan[],
  ): boolean {
    if (items.length <= 1) return false;

    const templateBase = toTemplateBase(templateName);
    if (
      !/^page(?:-.+)?$/.test(templateBase) &&
      templateBase !== 'frontend-page'
    ) {
      return false;
    }

    const runtimeItems = items.filter(
      (item) =>
        item.type === 'page' &&
        item.runtimeRenderer === 'runtime-page' &&
        item.isDetail === true &&
        !item.fixedSlug &&
        item.dataNeeds.includes('page-detail'),
    );
    const fixedItems = items.filter(
      (item) =>
        item.type === 'page' &&
        item.isDetail === true &&
        !!item.fixedSlug &&
        item.dataNeeds.includes('page-detail'),
    );

    if (runtimeItems.length > 1) {
      return false;
    }
    if (runtimeItems.length + fixedItems.length !== items.length) {
      return false;
    }
    if (fixedItems.length === 0) {
      return false;
    }

    const bindingKeys = new Set(
      fixedItems.map((item) =>
        String(item.fixedPageId ?? '').trim()
          ? `id:${String(item.fixedPageId).trim()}`
          : `slug:${String(item.fixedSlug).trim()}`,
      ),
    );

    return bindingKeys.size === fixedItems.length;
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
      'product-detail',
      'page-detail',
      'categoryDetail',
      'comments',
      'posts',
      'products',
      'pages',
      'menus',
      'site-info',
      'footer-links',
    ];
    return order.filter((need) => dataNeeds.includes(need));
  }

  private haveSameMembers(valuesA: string[], valuesB: string[]): boolean {
    if (valuesA.length !== valuesB.length) return false;
    const sortedA = [...valuesA].sort();
    const sortedB = [...valuesB].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
  }

  // Plan completeness gate: verify that key text literals present in draft
  // sections are not silently dropped by the AI visual planner.
  // Runs after validateDraftSectionFidelity so section count/type issues are
  // already caught. Only checks non-detail pages — partials and detail pages
  // have their own contract paths.
  private validateDraftLiteralCoverage(
    plan: PlanResult,
    errors: string[],
  ): void {
    for (const item of plan) {
      if (item.type !== 'page' || item.isDetail === true) continue;
      if (!item.draftSections?.length || !item.visualPlan?.sections?.length)
        continue;

      const expectedDraft = this.getContractExpectedDraftSections(item);
      if (!expectedDraft.length) continue;

      const visualSections = item.visualPlan.sections;

      for (let i = 0; i < expectedDraft.length; i++) {
        const draft = expectedDraft[i];
        const visual = visualSections[i];
        // Missing section is already caught by validateDraftSectionFidelity.
        if (!visual) continue;

        const dropped = this.findDroppedSectionLiterals(draft, visual);
        for (const literal of dropped) {
          errors.push(
            `Component "${item.componentName}" section ${i + 1} (${draft.type}): ` +
              `source-backed text "${literal}" was dropped in visual plan — ` +
              `visual planner must preserve all draft literals`,
          );
        }
      }
    }
  }

  // Returns draft literals (heading/subheading/title/subtitle) that are absent
  // from the visual section's full text content.
  private findDroppedSectionLiterals(
    draft: SectionPlan,
    visual: SectionPlan,
  ): string[] {
    const draftLiterals = this.extractKeyLiterals(draft);
    if (draftLiterals.length === 0) return [];
    const visualText = this.flattenSectionText(visual).toLowerCase();
    return draftLiterals.filter(
      (literal) => !visualText.includes(literal.toLowerCase()),
    );
  }

  // Extracts heading/subheading/title/subtitle — the fields most likely to
  // carry group-header text that the lossless mapper preserves but an AI
  // visual planner can drop. Skips dynamic bindings and very short strings.
  private extractKeyLiterals(section: SectionPlan): string[] {
    const results: string[] = [];
    const s = section as unknown as Record<string, unknown>;
    for (const field of ['heading', 'subheading', 'title', 'subtitle']) {
      const value = s[field];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length < 3) continue;
      if (/\{[a-zA-Z0-9_.]+\}/.test(trimmed)) continue; // dynamic binding
      results.push(trimmed);
    }
    return results;
  }

  // Recursively flattens all string values from a section into a single string.
  private flattenSectionText(section: SectionPlan): string {
    const parts: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        parts.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item);
      } else if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
          collect(v);
        }
      }
    };
    collect(section);
    return parts.join(' ');
  }
}
