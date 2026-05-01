import type { SourceRef } from './source-node-id.util.js';
import type { WpNode } from './wp-block-to-json.js';

type BlockNodeSpacing = NonNullable<WpNode['padding']>;
type BlockNodeTypography = NonNullable<WpNode['typography']>;

/**
 * Additive normalized block tree for block-centric planning work.
 * This intentionally preserves WordPress hierarchy without replacing the
 * current SectionPlan flow yet.
 */
export interface BlockNode {
  kind: string;
  blockName: string;
  sourceRef?: SourceRef;
  attrs?: Record<string, unknown>;
  customClassNames?: string[];
  text?: string;
  level?: number;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  href?: string;
  html?: string;
  bgColor?: string;
  textColor?: string;
  borderRadius?: string;
  gap?: string;
  padding?: BlockNodeSpacing;
  margin?: BlockNodeSpacing;
  minHeight?: string;
  overlayColor?: string;
  columnWidth?: string;
  textAlign?: string;
  justifyContent?: string;
  align?: string;
  menuOrientation?: WpNode['menuOrientation'];
  overlayMenu?: WpNode['overlayMenu'];
  isResponsive?: boolean;
  fontFamily?: string;
  typography?: BlockNodeTypography;
  templatePartSlug?: string;
  patternSlug?: string;
  refName?: string;
  tagName?: string;
  children?: BlockNode[];
}

export function mapWpNodesToBlockTree(nodes: WpNode[]): BlockNode[] {
  return nodes.map((node) => mapWpNodeToBlockNode(node));
}

function mapWpNodeToBlockNode(node: WpNode): BlockNode {
  const attrs = toRecord(node.params);
  const tagName = readStringParam(attrs, 'tagName');
  const templatePartSlug =
    node.block === 'core/template-part'
      ? readStringParam(attrs, 'slug')
      : undefined;
  const patternSlug =
    node.block === 'core/pattern' ? readStringParam(attrs, 'slug') : undefined;
  const refName = templatePartSlug ?? patternSlug;
  const children = Array.isArray(node.children)
    ? mapWpNodesToBlockTree(node.children)
    : undefined;

  return {
    kind: normalizeWpBlockKind(node.block),
    blockName: node.block,
    ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    ...(attrs ? { attrs } : {}),
    ...(node.customClassNames?.length
      ? { customClassNames: [...node.customClassNames] }
      : {}),
    ...(typeof node.text === 'string' ? { text: node.text } : {}),
    ...(typeof node.level === 'number' ? { level: node.level } : {}),
    ...(typeof node.src === 'string' ? { src: node.src } : {}),
    ...(typeof node.alt === 'string' ? { alt: node.alt } : {}),
    ...(typeof node.width === 'number' ? { width: node.width } : {}),
    ...(typeof node.height === 'number' ? { height: node.height } : {}),
    ...(typeof node.href === 'string' ? { href: node.href } : {}),
    ...(typeof node.html === 'string' ? { html: node.html } : {}),
    ...(typeof node.bgColor === 'string' ? { bgColor: node.bgColor } : {}),
    ...(typeof node.textColor === 'string'
      ? { textColor: node.textColor }
      : {}),
    ...(typeof node.borderRadius === 'string'
      ? { borderRadius: node.borderRadius }
      : {}),
    ...(typeof node.gap === 'string' ? { gap: node.gap } : {}),
    ...(node.padding ? { padding: { ...node.padding } } : {}),
    ...(node.margin ? { margin: { ...node.margin } } : {}),
    ...(typeof node.minHeight === 'string'
      ? { minHeight: node.minHeight }
      : {}),
    ...(typeof node.overlayColor === 'string'
      ? { overlayColor: node.overlayColor }
      : {}),
    ...(typeof node.columnWidth === 'string'
      ? { columnWidth: node.columnWidth }
      : {}),
    ...(typeof node.textAlign === 'string'
      ? { textAlign: node.textAlign }
      : {}),
    ...(typeof node.justifyContent === 'string'
      ? { justifyContent: node.justifyContent }
      : {}),
    ...(typeof node.align === 'string' ? { align: node.align } : {}),
    ...(node.menuOrientation ? { menuOrientation: node.menuOrientation } : {}),
    ...(node.overlayMenu ? { overlayMenu: node.overlayMenu } : {}),
    ...(typeof node.isResponsive === 'boolean'
      ? { isResponsive: node.isResponsive }
      : {}),
    ...(typeof node.fontFamily === 'string'
      ? { fontFamily: node.fontFamily }
      : {}),
    ...(node.typography ? { typography: { ...node.typography } } : {}),
    ...(templatePartSlug ? { templatePartSlug } : {}),
    ...(patternSlug ? { patternSlug } : {}),
    ...(refName ? { refName } : {}),
    ...(tagName ? { tagName } : {}),
    ...(children?.length ? { children } : {}),
  };
}

function normalizeWpBlockKind(blockName: string): string {
  const normalized = String(blockName ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'unknown';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function toRecord(
  value: Record<string, any> | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readStringParam(
  attrs: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
