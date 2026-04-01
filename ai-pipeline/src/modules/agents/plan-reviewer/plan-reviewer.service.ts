import { Injectable, Logger } from '@nestjs/common';
import type { ComponentPlan, PlanResult } from '../planner/planner.service.js';

export interface PlanReviewResult {
  plan: PlanResult;
  warnings: string[];
  errors: string[];
  isValid: boolean;
}

@Injectable()
export class PlanReviewerService {
  private readonly logger = new Logger(PlanReviewerService.name);

  review(plan: PlanResult): PlanReviewResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    let reviewed = [...plan];

    reviewed = this.fixDuplicateRoutes(reviewed, warnings);
    reviewed = this.fixTypeRouteInconsistencies(reviewed, warnings);
    this.checkVisualPlanCoverage(reviewed, warnings);
    this.checkDataNeeds(reviewed, warnings);
    this.validateHard(reviewed, errors);

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
    if (warnings.length > 0) {
      this.logger.warn(`${warnings.length} issue(s) found and auto-fixed:`);
      warnings.forEach((w) => this.logger.warn(`  - ${w}`));
    }
    if (errors.length === 0 && warnings.length === 0) {
      this.logger.log('Plan review passed ✓');
    }

    return { plan: reviewed, warnings, errors, isValid: errors.length === 0 };
  }

  // ── Hard validation (triggers retry) ─────────────────────────────────────

  private validateHard(plan: PlanResult, errors: string[]): void {
    if (plan.length === 0) {
      errors.push('Plan is empty — no components were generated');
      return;
    }
    const pages = plan.filter((c) => c.type === 'page');
    if (pages.length === 0) {
      errors.push(
        `Plan has no page components (${plan.length} partial(s) only) — at least one page is required`,
      );
    }
  }

  // ── Fix duplicate routes ───────────────────────────────────────────────────

  private fixDuplicateRoutes(plan: PlanResult, warnings: string[]): PlanResult {
    const routeCount = new Map<string, number>();
    for (const c of plan) {
      if (c.route) routeCount.set(c.route, (routeCount.get(c.route) ?? 0) + 1);
    }

    // Track all routes in the final plan to avoid collisions with derived names
    const allRoutes = new Set(plan.map((c) => c.route).filter(Boolean) as string[]);

    const seen = new Map<string, number>();
    return plan.map((c) => {
      if (!c.route || routeCount.get(c.route)! <= 1) return c;

      const count = seen.get(c.route) ?? 0;
      seen.set(c.route, count + 1);

      if (count === 0) return c; // first occurrence keeps original

      // Derive a meaningful route from the component name (PascalCase → kebab-case)
      const kebab = c.componentName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

      // For param routes (/page/:slug) replace the static prefix with the component-based prefix
      // For static routes (/blog) use /kebab-component-name directly
      let newRoute = c.route.includes(':')
        ? c.route.replace(/^\/[^/]+/, `/${kebab}`)  // /page/:slug → /page-wide/:slug
        : `/${kebab}`;                                // /blog → /index

      // Ensure no collision with existing routes
      if (allRoutes.has(newRoute)) {
        newRoute = `${newRoute}-${count + 1}`;
      }
      allRoutes.add(newRoute);

      warnings.push(`Duplicate route "${c.route}" on "${c.componentName}" → renamed to "${newRoute}"`);
      return { ...c, route: newRoute };
    });
  }

  // ── Fix type/route inconsistencies ────────────────────────────────────────

  private fixTypeRouteInconsistencies(plan: PlanResult, warnings: string[]): PlanResult {
    return plan.map((c) => {
      if (c.type === 'partial' && c.route !== null) {
        warnings.push(`Partial "${c.componentName}" had route "${c.route}" → cleared`);
        return { ...c, route: null };
      }
      if (c.type === 'page' && !c.route) {
        const fallback = `/${c.componentName.toLowerCase()}`;
        warnings.push(`Page "${c.componentName}" missing route → assigned "${fallback}"`);
        return { ...c, route: fallback };
      }
      return c;
    });
  }

  // ── Check visual plan coverage ────────────────────────────────────────────

  private checkVisualPlanCoverage(plan: PlanResult, warnings: string[]): void {
    const missing = plan.filter((c) => !c.visualPlan).map((c) => c.componentName);
    if (missing.length > 0) {
      warnings.push(
        `${missing.length} component(s) without visual plan (generator will use fallback AI): ${missing.join(', ')}`,
      );
    }
  }

  // ── Check dataNeeds completeness ──────────────────────────────────────────

  private checkDataNeeds(plan: PlanResult, warnings: string[]): void {
    for (const c of plan) {
      if (c.type === 'partial') continue;
      if (
        c.isDetail &&
        !c.dataNeeds.includes('post-detail') &&
        !c.dataNeeds.includes('page-detail')
      ) {
        warnings.push(
          `Detail page "${c.componentName}" (isDetail: true) missing "post-detail" or "page-detail" in dataNeeds`,
        );
      }
    }
  }
}
