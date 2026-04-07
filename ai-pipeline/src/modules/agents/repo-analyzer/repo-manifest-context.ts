import type { RepoThemeManifest } from './repo-analyzer.service.js';

function fmtList<T>(
  items: T[],
  limit: number,
  fmt: (item: T) => string,
): string {
  const preview = items.slice(0, limit).map(fmt).join(', ');
  const overflow = items.length - limit;
  return overflow > 0 ? `${preview} (+${overflow} more)` : preview;
}

export function buildRepoManifestContextNote(
  manifest?: RepoThemeManifest,
): string {
  if (!manifest) return '';

  const lines: string[] = ['## Theme repo source-of-truth hints'];
  const { themeTypeHints } = manifest;
  const vendorLabel = themeTypeHints.themeVendor
    ? ` (${themeTypeHints.themeVendor})`
    : '';
  lines.push(
    `Detected theme kind: ${themeTypeHints.detectedThemeKind} — slug: ${themeTypeHints.themeSlug}${vendorLabel}`,
  );

  if (themeTypeHints.usesPageBuilder) {
    const pb = themeTypeHints.pageBuilderSlug ?? 'unknown page builder';
    lines.push(
      `⚠ Page-builder theme: layouts are stored in DB via ${pb}, not in PHP template files. Do not rely on template files for page structure — use DB content instead.`,
    );
  }

  for (const note of themeTypeHints.themeVendorNotes) {
    lines.push(note);
  }

  if (manifest.sourceOfTruth.priorityDirectories.length > 0) {
    lines.push(
      `Priority directories: ${manifest.sourceOfTruth.priorityDirectories.join(', ')}`,
    );
  }

  if (manifest.sourceOfTruth.themeDirectories.length > 0) {
    lines.push(
      `Detected theme directories: ${manifest.sourceOfTruth.themeDirectories.join(', ')}`,
    );
  }

  if (manifest.sourceOfTruth.layoutFiles.length > 0) {
    lines.push('Primary layout files:');
    for (const file of manifest.sourceOfTruth.layoutFiles.slice(0, 12)) {
      lines.push(`- ${file}`);
    }
    if (manifest.sourceOfTruth.layoutFiles.length > 12) {
      lines.push(
        `- ... and ${manifest.sourceOfTruth.layoutFiles.length - 12} more layout file(s)`,
      );
    }
  }

  const { templatePartAreas } = manifest.themeJsonSummary;
  if (templatePartAreas.length > 0) {
    lines.push('Template part area assignments (from theme.json):');
    for (const part of templatePartAreas) {
      lines.push(
        `- ${part.name} → area: ${part.area}${part.title !== part.name ? ` (${part.title})` : ''}`,
      );
    }
  }

  if (manifest.sourceOfTruth.styleFiles.length > 0) {
    lines.push(
      `Primary style sources: ${manifest.sourceOfTruth.styleFiles.slice(0, 10).join(', ')}`,
    );
  }

  const { paletteColors } = manifest.themeJsonSummary;
  if (paletteColors.length > 0) {
    lines.push(
      `Theme palette colors: ${fmtList(paletteColors, 8, (c) => `${c.slug}:${c.color}`)}`,
    );
  }

  if (manifest.styleSources.discoveredFontFamilies.length > 0) {
    lines.push(
      `Discovered font families in CSS: ${manifest.styleSources.discoveredFontFamilies.slice(0, 8).join(', ')}`,
    );
  }

  const { customTemplateNames } = manifest.themeJsonSummary;
  if (customTemplateNames.length > 0) {
    lines.push(
      `Custom templates: ${fmtList(customTemplateNames, 8, (t) => (t.postTypes?.length ? `${t.name} (${t.postTypes.join(',')})` : t.name))}`,
    );
  }

  const { styleVariationNames } = manifest.themeJsonSummary;
  if (styleVariationNames.length > 0) {
    lines.push(
      `Style variations: ${fmtList(styleVariationNames, 6, (v) => v)}`,
    );
  }

  if (manifest.structureHints.templatePartRefs.length > 0) {
    lines.push(
      `Referenced template parts: ${manifest.structureHints.templatePartRefs.slice(0, 10).join(', ')}`,
    );
  }

  if (manifest.structureHints.patternRefs.length > 0) {
    lines.push(
      `Referenced patterns: ${manifest.structureHints.patternRefs.slice(0, 10).join(', ')}`,
    );
  }

  const { patternMeta } = manifest.structureHints;
  if (patternMeta.length > 0) {
    lines.push(`Available patterns (${patternMeta.length} total):`);
    for (const p of patternMeta.slice(0, 12)) {
      const cats =
        p.categories.length > 0 ? ` [${p.categories.join(', ')}]` : '';
      lines.push(`- ${p.slug}: "${p.title}"${cats}`);
    }
    if (patternMeta.length > 12) {
      lines.push(`- ... and ${patternMeta.length - 12} more pattern(s)`);
    }
  }

  const structuralSignals: string[] = [];
  if (manifest.structureHints.containsNavigation)
    structuralSignals.push('navigation');
  if (manifest.structureHints.containsSearch) structuralSignals.push('search');
  if (manifest.structureHints.containsComments)
    structuralSignals.push('comments');
  if (manifest.structureHints.containsQueryLoop)
    structuralSignals.push('query-loop');
  if (structuralSignals.length > 0) {
    lines.push(`Structural signals: ${structuralSignals.join(', ')}`);
  }

  if (manifest.themes.length > 0) {
    lines.push(`Available themes in repo (${manifest.themes.length} total):`);
    for (const theme of manifest.themes.slice(0, 12)) {
      const vendor = theme.vendor ? ` (${theme.vendor})` : '';
      const flags = [
        theme.detectedKind,
        theme.usesPageBuilder
          ? `page-builder:${theme.pageBuilderSlug ?? 'custom'}`
          : null,
      ].filter(Boolean);
      lines.push(
        `- ${theme.slug}${vendor}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
      );
    }
    if (manifest.themes.length > 12) {
      lines.push(`- ... and ${manifest.themes.length - 12} more theme(s)`);
    }
  }

  if (manifest.resolvedSource) {
    lines.push('## Resolved active source set');
    const {
      activeTheme,
      parentTheme,
      activePlugins,
      runtimeOnlyPlugins,
      repoOnlyPlugins,
    } = manifest.resolvedSource;
    const activeThemeLabel = activeTheme.presentInRepo
      ? `${activeTheme.slug}${activeTheme.relativeDir ? ` → ${activeTheme.relativeDir}` : ''}`
      : `${activeTheme.slug} (missing from repo)`;
    lines.push(`Active theme: ${activeThemeLabel}`);
    if (parentTheme) {
      const parentLabel = parentTheme.presentInRepo
        ? `${parentTheme.slug}${parentTheme.relativeDir ? ` → ${parentTheme.relativeDir}` : ''}`
        : `${parentTheme.slug} (missing from repo)`;
      lines.push(`Parent theme: ${parentLabel}`);
    }
    for (const note of manifest.resolvedSource.notes) {
      lines.push(note);
    }
  }

  for (const note of manifest.sourceOfTruth.notes) {
    lines.push(note);
  }

  lines.push(
    'Migration rule: follow these repo files and directories before inventing any new layout, spacing, marketing sections, or navigation structure.',
  );
  lines.push(
    'Migration rule: if the repo source is sparse/simple, keep the React output sparse/simple. Do not redesign.',
  );

  return lines.join('\n');
}
