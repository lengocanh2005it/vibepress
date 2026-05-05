import { wpBlocksToJson, type WpNode } from '../../../common/utils/wp-block-to-json.js';
import type { WpPage } from '../../sql/wp-query.service.js';
import {
  detectInteractiveWidgetsFromSource,
  scorePlanningSourceRichness,
} from './planning-source-analysis.util.js';

export type RuntimePageRenderStrategy = 'runtime' | 'dedicated';

export interface RuntimePageClassification {
  strategy: RuntimePageRenderStrategy;
  reason: string;
}

export function isDefaultRuntimePageTemplateCandidate(input: {
  templateName?: string;
  route?: string | null;
  type?: 'page' | 'partial';
  fixedSlug?: string;
  dataNeeds?: string[];
}): boolean {
  if (input.type !== 'page') return false;
  if (input.fixedSlug?.trim()) return false;
  if (input.route !== '/page/:slug') return false;
  const needs = new Set((input.dataNeeds ?? []).map((need) => need.trim()));
  if (!needs.has('page-detail')) return false;
  const templateName = normalizeTemplateIdentifier(input.templateName);
  return templateName === 'page';
}

export function classifyConcretePageForRuntime(page: WpPage): RuntimePageClassification {
  const pageTemplate = normalizeTemplateIdentifier(page.template);
  if (pageTemplate && pageTemplate !== 'default') {
    return {
      strategy: 'dedicated',
      reason: `custom-template:${pageTemplate}`,
    };
  }

  const source = String(page.content ?? '').trim();
  if (!source) {
    return {
      strategy: 'runtime',
      reason: 'empty-page-content',
    };
  }

  const interactiveWidgets = detectInteractiveWidgetsFromSource(source);
  if (interactiveWidgets.length > 0) {
    return {
      strategy: 'dedicated',
      reason: `interactive:${interactiveWidgets.join(',')}`,
    };
  }

  const pluginBlockMatch = source.match(/<!--\s*wp:([a-z0-9-]+\/[a-z0-9-]+)/gi);
  const pluginFamilies = new Set<string>();
  for (const match of pluginBlockMatch ?? []) {
    const normalized = match.toLowerCase();
    if (normalized.includes('uagb/')) pluginFamilies.add('uagb');
    else if (!normalized.includes('core/')) pluginFamilies.add('plugin');
  }
  if (pluginFamilies.size > 0) {
    return {
      strategy: 'dedicated',
      reason: `plugin-blocks:${[...pluginFamilies].join(',')}`,
    };
  }

  const richness = scorePlanningSourceRichness(source);
  const stats = collectBlockStats(source);
  const hasLayoutShell =
    stats.blockNames.has('core/columns') ||
    stats.blockNames.has('core/cover') ||
    stats.blockNames.has('core/media-text') ||
    stats.blockNames.has('core/gallery');

  const simpleCoreBody =
    stats.nodeCount <= 10 &&
    stats.maxDepth <= 3 &&
    stats.distinctBlockCount <= 4 &&
    !hasLayoutShell;

  if (simpleCoreBody && richness < 180) {
    return {
      strategy: 'runtime',
      reason: `simple-core-body:nodes=${stats.nodeCount},distinct=${stats.distinctBlockCount},score=${richness}`,
    };
  }

  if (
    richness >= 220 ||
    stats.nodeCount >= 28 ||
    stats.maxDepth >= 5 ||
    stats.distinctBlockCount >= 8 ||
    (hasLayoutShell && stats.nodeCount >= 12)
  ) {
    return {
      strategy: 'dedicated',
      reason: `complex-layout:nodes=${stats.nodeCount},depth=${stats.maxDepth},distinct=${stats.distinctBlockCount},score=${richness}`,
    };
  }

  if (hasLayoutShell) {
    return {
      strategy: 'dedicated',
      reason: `layout-shell:nodes=${stats.nodeCount},score=${richness}`,
    };
  }

  return {
    strategy: 'runtime',
    reason: `default-runtime:nodes=${stats.nodeCount},distinct=${stats.distinctBlockCount},score=${richness}`,
  };
}

function collectBlockStats(source: string): {
  nodeCount: number;
  maxDepth: number;
  distinctBlockCount: number;
  blockNames: Set<string>;
} {
  try {
    const nodes = wpBlocksToJson(source);
    let nodeCount = 0;
    let maxDepth = 0;
    const blockNames = new Set<string>();

    const visit = (node: WpNode, depth: number) => {
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, depth);
      blockNames.add(normalizeBlockName(node.block));
      for (const child of node.children ?? []) visit(child, depth + 1);
    };

    for (const node of nodes) visit(node, 1);
    return {
      nodeCount,
      maxDepth,
      distinctBlockCount: blockNames.size,
      blockNames,
    };
  } catch {
    return {
      nodeCount: (source.match(/<!--\s*wp:/g) ?? []).length,
      maxDepth: 1,
      distinctBlockCount: 0,
      blockNames: new Set<string>(),
    };
  }
}

function normalizeTemplateIdentifier(value: string | undefined): string {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.replace(/\.(php|html)$/i, '');
}

function normalizeBlockName(value: string | undefined): string {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return 'unknown';
  return trimmed.includes('/') ? trimmed : `core/${trimmed}`;
}
