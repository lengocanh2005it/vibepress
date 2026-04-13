import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import ts from 'typescript';
import { isPartialComponentName } from '../agents/shared/component-kind.util.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import type { GeneratedComponent } from '../agents/react-generator/react-generator.service.js';
import type { PipelineCaptureAttachmentDto } from '../orchestrator/orchestrator.dto.js';
import type {
  ResolvedCaptureTargetRecord,
  UiMutationCandidate,
  UiMutationNodeRole,
  UiSourceMapEntry,
} from './ui-source-map.types.js';

export async function buildUiSourceMapForProject(input: {
  srcDir: string;
  components: GeneratedComponent[];
  plan?: PlanResult;
}): Promise<UiSourceMapEntry[]> {
  const { srcDir, components, plan } = input;
  const entries = createUiSourceMapEntryAccumulator(plan);

  for (const component of components) {
    const outputFilePath = resolveComponentOutputFilePath(component);
    const absoluteFilePath = join(
      srcDir,
      outputFilePath.replace(/^src[\\/]/, ''),
    );
    const extracted = await extractUiSourceMapEntriesFromFile(
      absoluteFilePath,
      toPosixPath(outputFilePath),
    );

    for (const entry of extracted) {
      const existing = entries.get(entry.sourceNodeId);
      entries.set(entry.sourceNodeId, mergeUiSourceMapEntry(existing, entry));
    }
  }

  return sortUiSourceMapEntries(entries);
}

export async function buildUiSourceMapForGeneratedComponents(input: {
  components: GeneratedComponent[];
  plan?: PlanResult;
}): Promise<UiSourceMapEntry[]> {
  const { components, plan } = input;
  const entries = createUiSourceMapEntryAccumulator(plan);

  for (const component of components) {
    const outputFilePath = resolveComponentOutputFilePath(component);
    const absoluteFilePath = join(
      'virtual-generated',
      outputFilePath.replace(/^src[\\/]/, ''),
    );
    const extracted = extractUiSourceMapEntriesFromCode(
      component.code,
      absoluteFilePath,
      toPosixPath(outputFilePath),
    );

    for (const entry of extracted) {
      const existing = entries.get(entry.sourceNodeId);
      entries.set(entry.sourceNodeId, mergeUiSourceMapEntry(existing, entry));
    }
  }

  return sortUiSourceMapEntries(entries);
}

export async function buildUiMutationCandidatesForGeneratedComponents(input: {
  components: GeneratedComponent[];
}): Promise<UiMutationCandidate[]> {
  const { components } = input;
  const candidates = new Map<string, UiMutationCandidate>();

  for (const component of components) {
    const outputFilePath = resolveComponentOutputFilePath(component);
    const absoluteFilePath = join(
      'virtual-generated',
      outputFilePath.replace(/^src[\\/]/, ''),
    );
    const extracted = extractUiMutationCandidatesFromCode(
      component.code,
      absoluteFilePath,
      toPosixPath(outputFilePath),
    );

    for (const candidate of extracted) {
      candidates.set(candidate.candidateId, candidate);
    }
  }

  return Array.from(candidates.values()).sort((left, right) => {
    if (left.outputFilePath !== right.outputFilePath) {
      return left.outputFilePath.localeCompare(right.outputFilePath);
    }
    if (
      (left.startLine ?? Number.MAX_SAFE_INTEGER) !==
      (right.startLine ?? Number.MAX_SAFE_INTEGER)
    ) {
      return (
        (left.startLine ?? Number.MAX_SAFE_INTEGER) -
        (right.startLine ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return left.candidateId.localeCompare(right.candidateId);
  });
}

export async function writeUiSourceMapArtifacts(input: {
  entries: UiSourceMapEntry[];
  previewDir: string;
  frontendDir: string;
}): Promise<string> {
  const { entries, previewDir, frontendDir } = input;
  const payload = `${JSON.stringify(entries, null, 2)}\n`;
  const previewPath = join(previewDir, 'ui-source-map.json');
  const publicPath = join(frontendDir, 'public', 'ui-source-map.json');

  await mkdir(join(frontendDir, 'public'), { recursive: true });
  await writeFile(previewPath, payload, 'utf-8');
  await writeFile(publicPath, payload, 'utf-8');

  return previewPath;
}

export async function readUiSourceMapEntries(
  filePath?: string | null,
): Promise<UiSourceMapEntry[]> {
  if (!filePath) return [];

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UiSourceMapEntry[]) : [];
  } catch {
    return [];
  }
}

export function resolveCaptureTargetsFromUiSourceMap(input: {
  attachments?: PipelineCaptureAttachmentDto[];
  uiSourceMap: UiSourceMapEntry[];
}): ResolvedCaptureTargetRecord[] {
  const { attachments, uiSourceMap } = input;
  if (!attachments?.length || uiSourceMap.length === 0) return [];

  const bySourceNodeId = new Map(
    uiSourceMap.map((entry) => [entry.sourceNodeId, entry]),
  );
  const byTemplateAndIndex = new Map<string, UiSourceMapEntry[]>();
  for (const entry of uiSourceMap) {
    const key = buildTemplateIndexKey(entry.templateName, entry.topLevelIndex);
    const bucket = byTemplateAndIndex.get(key) ?? [];
    bucket.push(entry);
    byTemplateAndIndex.set(key, bucket);
  }

  return attachments
    .map((attachment) => {
      const exactSourceNodeId = attachment.targetNode?.sourceNodeId?.trim();
      if (exactSourceNodeId) {
        const exact = bySourceNodeId.get(exactSourceNodeId);
        if (exact) {
          return toResolvedCaptureTargetRecord(attachment.id, exact, {
            resolution: 'exact-source-map',
            confidence:
              typeof exact.startLine === 'number' &&
              typeof exact.endLine === 'number'
                ? 1
                : 0.94,
          });
        }
      }

      const templateName = attachment.targetNode?.templateName?.trim();
      const topLevelIndex = attachment.targetNode?.topLevelIndex;
      if (!templateName || typeof topLevelIndex !== 'number') return undefined;

      const heuristicCandidates =
        byTemplateAndIndex.get(
          buildTemplateIndexKey(templateName, topLevelIndex),
        ) ?? [];
      if (heuristicCandidates.length !== 1) return undefined;

      return toResolvedCaptureTargetRecord(
        attachment.id,
        heuristicCandidates[0],
        {
          resolution: 'heuristic',
          confidence: 0.72,
        },
      );
    })
    .filter((value): value is ResolvedCaptureTargetRecord => !!value);
}

function buildFallbackUiSourceMapEntries(
  plan?: PlanResult,
): UiSourceMapEntry[] {
  if (!plan?.length) return [];

  return plan.flatMap((componentPlan) => {
    const outputFilePath = toPosixPath(
      `${componentPlan.type === 'partial' ? 'src/components' : 'src/pages'}/${componentPlan.componentName}.tsx`,
    );

    return (componentPlan.visualPlan?.sections ?? [])
      .filter((section) => !!section.sourceRef?.sourceNodeId)
      .map((section, index) => ({
        ...section.sourceRef!,
        componentName: componentPlan.componentName,
        sectionKey:
          section.sectionKey ?? buildFallbackSectionKey(section.type, index),
        sectionComponentName: buildSectionComponentName(
          componentPlan.componentName,
          section.sectionKey ?? section.type,
        ),
        outputFilePath,
      }));
  });
}

async function extractUiSourceMapEntriesFromFile(
  absoluteFilePath: string,
  outputFilePath: string,
): Promise<UiSourceMapEntry[]> {
  let code = '';
  try {
    code = await readFile(absoluteFilePath, 'utf-8');
  } catch {
    return [];
  }

  return extractUiSourceMapEntriesFromCode(
    code,
    absoluteFilePath,
    outputFilePath,
  );
}

function extractUiSourceMapEntriesFromCode(
  code: string,
  absoluteFilePath: string,
  outputFilePath: string,
): UiSourceMapEntry[] {
  const sourceFile = ts.createSourceFile(
    absoluteFilePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const entries: UiSourceMapEntry[] = [];

  const visit = (node: ts.Node) => {
    const tracked =
      readTrackedEntryFromJsxElement(node, sourceFile, outputFilePath) ??
      undefined;
    if (tracked) {
      entries.push(tracked);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return entries;
}

function extractUiMutationCandidatesFromCode(
  code: string,
  absoluteFilePath: string,
  outputFilePath: string,
): UiMutationCandidate[] {
  const sourceFile = ts.createSourceFile(
    absoluteFilePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const candidates: UiMutationCandidate[] = [];

  const visit = (node: ts.Node) => {
    const candidate =
      readUiMutationCandidateFromJsxNode(node, sourceFile, outputFilePath) ??
      undefined;
    if (candidate) {
      candidates.push(candidate);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return candidates;
}

function readTrackedEntryFromJsxElement(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  outputFilePath: string,
): UiSourceMapEntry | null {
  let attributes: ts.JsxAttributes | undefined;
  let rangeNode: ts.Node = node;

  if (ts.isJsxElement(node)) {
    attributes = node.openingElement.attributes;
    rangeNode = node;
  } else if (ts.isJsxSelfClosingElement(node)) {
    attributes = node.attributes;
    rangeNode = node;
  } else {
    return null;
  }

  const sourceNodeId = readStringJsxAttribute(
    attributes,
    'data-vp-source-node',
  );
  if (!sourceNodeId) return null;

  const componentName =
    readStringJsxAttribute(attributes, 'data-vp-component') ??
    deriveComponentNameFromOutputPath(outputFilePath);
  const templateName =
    readStringJsxAttribute(attributes, 'data-vp-template') ??
    'unknown-template';
  const sourceFilePath =
    readStringJsxAttribute(attributes, 'data-vp-source-file') ??
    'unknown-source';
  const sectionKey =
    readStringJsxAttribute(attributes, 'data-vp-section-key') ??
    'unknown-section';
  const sectionComponentName =
    readStringJsxAttribute(attributes, 'data-vp-section-component') ??
    undefined;

  const start = sourceFile.getLineAndCharacterOfPosition(
    rangeNode.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(rangeNode.getEnd());

  return {
    sourceNodeId,
    templateName,
    sourceFile: sourceFilePath,
    topLevelIndex: deriveTopLevelIndexFromSourceNodeId(sourceNodeId),
    componentName,
    sectionKey,
    sectionComponentName,
    outputFilePath,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function readUiMutationCandidateFromJsxNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  outputFilePath: string,
): UiMutationCandidate | null {
  const jsxNode = asJsxNode(node);
  if (!jsxNode) return null;

  const attributes = getJsxAttributes(jsxNode);
  const elementTag = getJsxTagName(jsxNode);
  const nodeRole = inferUiMutationNodeRole(jsxNode, attributes, elementTag);
  if (!nodeRole) return null;

  const owner = findNearestTrackedOwner(jsxNode, outputFilePath);
  const componentName =
    readStringJsxAttribute(attributes, 'data-vp-component') ??
    owner?.ownerComponentName ??
    deriveComponentNameFromOutputPath(outputFilePath);
  const sourceNodeId = readStringJsxAttribute(
    attributes,
    'data-vp-source-node',
  );
  const textPreview = extractJsxNodeTextPreview(jsxNode);
  const start = sourceFile.getLineAndCharacterOfPosition(
    jsxNode.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(jsxNode.getEnd());
  const candidateId = [
    outputFilePath,
    start.line + 1,
    nodeRole,
    elementTag,
    sourceNodeId ?? owner?.ownerSourceNodeId ?? 'untracked',
  ].join(':');

  return {
    candidateId,
    componentName,
    outputFilePath,
    nodeRole,
    elementTag,
    ownerComponentName: owner?.ownerComponentName,
    ownerSourceNodeId: owner?.ownerSourceNodeId,
    ownerSectionKey: owner?.ownerSectionKey,
    sourceNodeId: sourceNodeId ?? undefined,
    textPreview: textPreview || undefined,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function readStringJsxAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): string | undefined {
  const attr = attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attr?.initializer) return undefined;
  if (ts.isStringLiteral(attr.initializer)) {
    return attr.initializer.text.trim() || undefined;
  }
  if (
    ts.isJsxExpression(attr.initializer) &&
    attr.initializer.expression &&
    ts.isStringLiteralLike(attr.initializer.expression)
  ) {
    return attr.initializer.expression.text.trim() || undefined;
  }
  return undefined;
}

function asJsxNode(
  node: ts.Node,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    return node;
  }
  return null;
}

function getJsxAttributes(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): ts.JsxAttributes {
  return ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
}

function getJsxTagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tagName = ts.isJsxElement(node)
    ? node.openingElement.tagName.getText()
    : node.tagName.getText();
  return tagName.trim();
}

function inferUiMutationNodeRole(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  attributes: ts.JsxAttributes,
  elementTag: string,
): UiMutationNodeRole | null {
  const explicitRole = normalizeUiMutationNodeRole(
    readStringJsxAttribute(attributes, 'data-vp-node-role'),
  );
  if (explicitRole) return explicitRole;

  const normalizedTag = elementTag.toLowerCase();
  const sourceNodeId = readStringJsxAttribute(
    attributes,
    'data-vp-source-node',
  );
  const className =
    readStringJsxAttribute(attributes, 'className')?.toLowerCase() ?? '';

  if (/^h[1-6]$/.test(normalizedTag)) return 'heading';
  if (normalizedTag === 'button') return 'button';
  if (normalizedTag === 'a' || normalizedTag === 'link') {
    if (/\b(btn|button|cta)\b/.test(className)) return 'button';
    return 'link';
  }
  if (normalizedTag === 'img') return 'media';
  if (normalizedTag === 'form') return 'form';
  if (['input', 'textarea', 'select'].includes(normalizedTag)) return 'input';
  if (['ul', 'ol', 'li'].includes(normalizedTag)) return 'list';
  if (normalizedTag === 'p') return 'text';
  if (normalizedTag === 'span' && extractJsxNodeTextPreview(node))
    return 'text';

  if (
    ['section', 'header', 'footer', 'main', 'article', 'aside', 'nav'].includes(
      normalizedTag,
    )
  ) {
    return sourceNodeId ? 'section' : 'container';
  }

  if (normalizedTag === 'div') {
    if (/\b(card|panel|tile|box|badge)\b/.test(className)) return 'card';
    if (sourceNodeId) return 'container';
    return null;
  }

  if (sourceNodeId) return 'container';
  return null;
}

function normalizeUiMutationNodeRole(
  value?: string,
): UiMutationNodeRole | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (
    [
      'section',
      'container',
      'card',
      'button',
      'link',
      'heading',
      'text',
      'media',
      'form',
      'input',
      'list',
      'unknown',
    ].includes(normalized)
  ) {
    return normalized as UiMutationNodeRole;
  }
  return null;
}

function findNearestTrackedOwner(
  node: ts.Node,
  outputFilePath: string,
): {
  ownerSourceNodeId?: string;
  ownerSectionKey?: string;
  ownerComponentName?: string;
} | null {
  let current: ts.Node | undefined = node;

  while (current) {
    const jsxNode = asJsxNode(current);
    if (jsxNode) {
      const attributes = getJsxAttributes(jsxNode);
      const ownerSourceNodeId = readStringJsxAttribute(
        attributes,
        'data-vp-source-node',
      );
      if (ownerSourceNodeId) {
        return {
          ownerSourceNodeId,
          ownerSectionKey: readStringJsxAttribute(
            attributes,
            'data-vp-section-key',
          ),
          ownerComponentName:
            readStringJsxAttribute(attributes, 'data-vp-component') ??
            deriveComponentNameFromOutputPath(outputFilePath),
        };
      }
    }
    current = current.parent;
  }

  return null;
}

function extractJsxNodeTextPreview(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): string {
  if (ts.isJsxSelfClosingElement(node)) {
    return '';
  }

  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      const value = child.getText().replace(/\s+/g, ' ').trim();
      if (value) parts.push(value);
      continue;
    }
    if (
      ts.isJsxExpression(child) &&
      child.expression &&
      ts.isStringLiteralLike(child.expression)
    ) {
      const value = child.expression.text.replace(/\s+/g, ' ').trim();
      if (value) parts.push(value);
      continue;
    }
    if (ts.isJsxElement(child)) {
      const value = extractJsxNodeTextPreview(child);
      if (value) parts.push(value);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function mergeUiSourceMapEntry(
  existing: UiSourceMapEntry | undefined,
  next: UiSourceMapEntry,
): UiSourceMapEntry {
  if (!existing) return next;

  return {
    ...existing,
    ...next,
    sectionComponentName:
      next.sectionComponentName ?? existing.sectionComponentName,
    exportName: next.exportName ?? existing.exportName,
    startLine: next.startLine ?? existing.startLine,
    endLine: next.endLine ?? existing.endLine,
  };
}

function resolveComponentOutputFilePath(component: GeneratedComponent): string {
  const folder =
    component.type === 'partial' ||
    component.isSubComponent === true ||
    isPartialComponentName(component.name)
      ? 'src/components'
      : 'src/pages';

  return toPosixPath(`${folder}/${component.name}.tsx`);
}

export function deriveComponentNameFromOutputPath(
  outputFilePath: string,
): string {
  const fileName = outputFilePath.split('/').pop() ?? outputFilePath;
  return fileName.replace(/\.tsx$/i, '');
}

function deriveTopLevelIndexFromSourceNodeId(sourceNodeId: string): number {
  const parts = sourceNodeId.split('::');
  const pathToken = parts[2] ?? '0';
  const topLevel = Number(pathToken.split('.')[0] ?? 0);
  return Number.isFinite(topLevel) ? topLevel : 0;
}

function buildTemplateIndexKey(
  templateName: string,
  topLevelIndex: number,
): string {
  return `${templateName}::${topLevelIndex}`;
}

function toResolvedCaptureTargetRecord(
  captureId: string,
  entry: UiSourceMapEntry,
  input: {
    resolution: ResolvedCaptureTargetRecord['resolution'];
    confidence: number;
  },
): ResolvedCaptureTargetRecord {
  return {
    captureId,
    sourceNodeId: entry.sourceNodeId,
    templateName: entry.templateName,
    sourceFile: entry.sourceFile,
    componentName: entry.componentName,
    sectionKey: entry.sectionKey,
    sectionComponentName: entry.sectionComponentName,
    outputFilePath: entry.outputFilePath,
    startLine: entry.startLine,
    endLine: entry.endLine,
    resolution: input.resolution,
    confidence: input.confidence,
  };
}

function buildFallbackSectionKey(type: string, index: number): string {
  return index === 0 ? type : `${type}-${index}`;
}

function buildSectionComponentName(
  componentName: string,
  sectionKey: string,
): string {
  return `${componentName}${toPascalCase(sectionKey)}Section`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join('');
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function createUiSourceMapEntryAccumulator(
  plan?: PlanResult,
): Map<string, UiSourceMapEntry> {
  const entries = new Map<string, UiSourceMapEntry>();

  for (const entry of buildFallbackUiSourceMapEntries(plan)) {
    entries.set(entry.sourceNodeId, entry);
  }

  return entries;
}

function sortUiSourceMapEntries(
  entries: Map<string, UiSourceMapEntry>,
): UiSourceMapEntry[] {
  return Array.from(entries.values()).sort((left, right) => {
    if (left.outputFilePath !== right.outputFilePath) {
      return left.outputFilePath.localeCompare(right.outputFilePath);
    }
    if (
      (left.startLine ?? Number.MAX_SAFE_INTEGER) !==
      (right.startLine ?? Number.MAX_SAFE_INTEGER)
    ) {
      return (
        (left.startLine ?? Number.MAX_SAFE_INTEGER) -
        (right.startLine ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return left.sourceNodeId.localeCompare(right.sourceNodeId);
  });
}
