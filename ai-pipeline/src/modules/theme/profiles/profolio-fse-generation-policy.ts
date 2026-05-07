export const PROFOLIO_FSE_AI_LOCKED_VISUAL_PLAN_TEMPLATES = new Set([
  'front-page',
  'template-about',
  'template-contact',
  'template-services',
]);

export const PROFOLIO_FSE_AI_LOCKED_VISUAL_PLAN_COMPONENTS = new Set([
  'frontpage',
  'templateabout',
  'templatecontact',
  'templateservices',
]);

export const PROFOLIO_FSE_DETERMINISTIC_STRUCTURE_TEMPLATES = new Set([
  '404',
  'archive',
  'archive-product',
  'blog-left-sidebar',
  'blog-right-sidebar',
  'cart',
  'checkout',
  'index',
  'search',
  'single',
  'single-product',
]);

export const PROFOLIO_FSE_DETERMINISTIC_STRUCTURE_COMPONENTS = new Set([
  'notfound',
  'archive',
  'archiveproduct',
  'blogleftsidebar',
  'blogrightsidebar',
  'cart',
  'checkout',
  'index',
  'search',
  'single',
  'singleproduct',
]);

export function normalizeProfolioFseTemplateIdentifier(
  value: string | undefined,
): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^templates\//, '')
    .replace(/^patterns\//, '')
    .replace(/\.(html|php)$/i, '');
}

export function normalizeProfolioFseComponentIdentifier(
  value: string | undefined,
): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function isProfolioFseAiLockedVisualPlanSurface(input: {
  templateName?: string;
  componentName?: string;
}): boolean {
  return (
    PROFOLIO_FSE_AI_LOCKED_VISUAL_PLAN_TEMPLATES.has(
      normalizeProfolioFseTemplateIdentifier(input.templateName),
    ) ||
    PROFOLIO_FSE_AI_LOCKED_VISUAL_PLAN_COMPONENTS.has(
      normalizeProfolioFseComponentIdentifier(input.componentName),
    )
  );
}

export function isProfolioFseDeterministicStructureSurface(input: {
  templateName?: string;
  componentName?: string;
}): boolean {
  return (
    PROFOLIO_FSE_DETERMINISTIC_STRUCTURE_TEMPLATES.has(
      normalizeProfolioFseTemplateIdentifier(input.templateName),
    ) ||
    PROFOLIO_FSE_DETERMINISTIC_STRUCTURE_COMPONENTS.has(
      normalizeProfolioFseComponentIdentifier(input.componentName),
    )
  );
}
