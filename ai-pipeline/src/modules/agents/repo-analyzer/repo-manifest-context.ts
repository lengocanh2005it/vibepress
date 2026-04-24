import type { RepoThemeManifest } from './repo-analyzer.service.js';

export interface RepoManifestContextOptions {
  mode?: 'full' | 'compact';
  includeLayoutHints?: boolean;
  includeStyleHints?: boolean;
  includeStructureHints?: boolean;
}

function fmtList<T>(
  items: T[],
  limit: number,
  fmt: (item: T) => string,
): string {
  const preview = items.slice(0, limit).map(fmt).join(', ');
  const overflow = items.length - limit;
  return overflow > 0 ? `${preview} (+${overflow} more)` : preview;
}

function fmtTokens(items: string[], limit: number): string {
  if (items.length === 0) return 'none';
  return fmtList(items, limit, (item) => item);
}

export function buildRepoManifestContextNote(
  manifest?: RepoThemeManifest,
  options?: RepoManifestContextOptions,
): string {
  if (!manifest) return '';

  const mode = options?.mode ?? 'full';
  const includeLayoutHints = options?.includeLayoutHints ?? true;
  const includeStyleHints = options?.includeStyleHints ?? true;
  const includeStructureHints = options?.includeStructureHints ?? true;

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

  if (
    includeLayoutHints &&
    manifest.sourceOfTruth.priorityDirectories.length > 0
  ) {
    lines.push(
      `Priority directories: ${manifest.sourceOfTruth.priorityDirectories.slice(0, mode === 'compact' ? 3 : 999).join(', ')}`,
    );
  }

  if (
    includeLayoutHints &&
    manifest.sourceOfTruth.themeDirectories.length > 0
  ) {
    lines.push(
      `Detected theme directories: ${manifest.sourceOfTruth.themeDirectories.slice(0, mode === 'compact' ? 3 : 999).join(', ')}`,
    );
  }

  if (includeLayoutHints && manifest.sourceOfTruth.layoutFiles.length > 0) {
    lines.push('Primary layout files:');
    for (const file of manifest.sourceOfTruth.layoutFiles.slice(
      0,
      mode === 'compact' ? 4 : 12,
    )) {
      lines.push(`- ${file}`);
    }
    const layoutLimit = mode === 'compact' ? 4 : 12;
    if (manifest.sourceOfTruth.layoutFiles.length > layoutLimit) {
      lines.push(
        `- ... and ${manifest.sourceOfTruth.layoutFiles.length - layoutLimit} more layout file(s)`,
      );
    }
  }

  const { templatePartAreas } = manifest.themeJsonSummary;
  if (includeStructureHints && templatePartAreas.length > 0) {
    lines.push('Template part area assignments (from theme.json):');
    for (const part of templatePartAreas.slice(
      0,
      mode === 'compact' ? 6 : 999,
    )) {
      lines.push(
        `- ${part.name} → area: ${part.area}${part.title !== part.name ? ` (${part.title})` : ''}`,
      );
    }
  }

  if (includeStyleHints && manifest.sourceOfTruth.styleFiles.length > 0) {
    lines.push(
      `Primary style sources: ${manifest.sourceOfTruth.styleFiles.slice(0, mode === 'compact' ? 4 : 10).join(', ')}`,
    );
  }

  const { paletteColors } = manifest.themeJsonSummary;
  if (includeStyleHints && paletteColors.length > 0) {
    lines.push(
      `Theme palette colors: ${fmtList(paletteColors, mode === 'compact' ? 5 : 8, (c) => `${c.slug}:${c.color}`)}`,
    );
  }

  if (
    includeStyleHints &&
    manifest.styleSources.discoveredFontFamilies.length > 0
  ) {
    lines.push(
      `Discovered font families in CSS: ${manifest.styleSources.discoveredFontFamilies.slice(0, mode === 'compact' ? 4 : 8).join(', ')}`,
    );
  }

  const { customTemplateNames } = manifest.themeJsonSummary;
  if (includeLayoutHints && customTemplateNames.length > 0) {
    lines.push(
      `Custom templates: ${fmtList(customTemplateNames, mode === 'compact' ? 4 : 8, (t) => (t.postTypes?.length ? `${t.name} (${t.postTypes.join(',')})` : t.name))}`,
    );
  }

  const { styleVariationNames } = manifest.themeJsonSummary;
  if (includeStyleHints && styleVariationNames.length > 0) {
    lines.push(
      `Style variations: ${fmtList(styleVariationNames, mode === 'compact' ? 3 : 6, (v) => v)}`,
    );
  }

  if (
    includeStructureHints &&
    manifest.structureHints.templatePartRefs.length > 0
  ) {
    lines.push(
      `Referenced template parts: ${manifest.structureHints.templatePartRefs.slice(0, mode === 'compact' ? 5 : 10).join(', ')}`,
    );
  }

  if (includeStructureHints && manifest.structureHints.patternRefs.length > 0) {
    lines.push(
      `Referenced patterns: ${manifest.structureHints.patternRefs.slice(0, mode === 'compact' ? 5 : 10).join(', ')}`,
    );
  }

  const { patternMeta } = manifest.structureHints;
  if (includeStructureHints && mode !== 'compact' && patternMeta.length > 0) {
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
  const uagbBlockTypes = manifest.structureHints.blockTypes.filter((block) =>
    block.startsWith('uagb/'),
  );
  if (includeStructureHints && uagbBlockTypes.length > 0) {
    const limit = mode === 'compact' ? 5 : 10;
    lines.push(
      `Detected UAGB/Spectra block types in repo source: ${uagbBlockTypes
        .slice(0, limit)
        .join(
          ', ',
        )}${uagbBlockTypes.length > limit ? ` (+${uagbBlockTypes.length - limit} more)` : ''}`,
    );
  }
  if (manifest.uagbSummary?.detected) {
    lines.push(
      `Merged UAGB detection: plugins=${manifest.uagbSummary.mergedPluginSlugs.join(', ') || 'none'}; blocks=${manifest.uagbSummary.mergedBlockTypes.join(', ') || 'none'}`,
    );
    const homeUsage =
      manifest.uagbSummary.db.pages.find((entry) => entry.isHome) ??
      manifest.uagbSummary.db.templates.find((entry) => entry.isHome);
    if (homeUsage) {
      lines.push(
        `UAGB home from DB ${homeUsage.entityType}: ${homeUsage.slug}=[${homeUsage.blockTypes.join(', ')}]`,
      );
    }
    if (manifest.uagbSummary.db.pages.length > 0) {
      lines.push(
        `UAGB pages from DB: ${manifest.uagbSummary.db.pages
          .slice(0, mode === 'compact' ? 4 : 8)
          .map((page) => `${page.slug}=[${page.blockTypes.join(', ')}]`)
          .join(
            ', ',
          )}${manifest.uagbSummary.db.pages.length > (mode === 'compact' ? 4 : 8) ? ` (+${manifest.uagbSummary.db.pages.length - (mode === 'compact' ? 4 : 8)} more)` : ''}`,
      );
    }
    if (manifest.uagbSummary.db.templates.length > 0) {
      lines.push(
        `UAGB templates from DB: ${manifest.uagbSummary.db.templates
          .slice(0, mode === 'compact' ? 4 : 8)
          .map(
            (template) =>
              `${template.slug}=[${template.blockTypes.join(', ')}]`,
          )
          .join(
            ', ',
          )}${manifest.uagbSummary.db.templates.length > (mode === 'compact' ? 4 : 8) ? ` (+${manifest.uagbSummary.db.templates.length - (mode === 'compact' ? 4 : 8)} more)` : ''}`,
      );
    }
  }
  if (includeStructureHints && manifest.interactiveContracts?.spectra?.detected) {
    const spectra = manifest.interactiveContracts.spectra;
    const widgetLines = Object.entries(spectra.widgets)
      .map(([widget, contract]) => {
        if (!contract) return null;
        const attrs =
          contract.attrKeys.length > 0
            ? ` attrs=${contract.attrKeys.join(', ')}`
            : '';
        return `${widget}:${contract.blockType}${attrs}`;
      })
      .filter((line): line is string => !!line);
    if (widgetLines.length > 0) {
      lines.push(
        `Spectra plugin contracts from repo plugin source: ${widgetLines.join(' | ')}`,
      );
    }
    const appearanceLines = Object.entries(spectra.widgets)
      .map(([widget, contract]) => {
        if (!contract?.appearance) return null;
        const appearance = contract.appearance;
        const parts = [
          `wrappers=${fmtTokens(appearance.wrapperClasses, 4)}`,
          `items=${fmtTokens(appearance.itemClasses, 5)}`,
          appearance.activeClasses.length > 0
            ? `active=${fmtTokens(appearance.activeClasses, 4)}`
            : null,
          appearance.variantClasses.length > 0
            ? `variants=${fmtTokens(appearance.variantClasses, 5)}`
            : null,
          appearance.behaviorClasses.length > 0
            ? `behavior=${fmtTokens(appearance.behaviorClasses, 5)}`
            : null,
          appearance.alignmentClasses.length > 0
            ? `align=${fmtTokens(appearance.alignmentClasses, 4)}`
            : null,
          appearance.styleCues.length > 0
            ? `cues=${fmtTokens(appearance.styleCues, 3)}`
            : null,
        ].filter((part): part is string => !!part);
        return `${widget}: ${parts.join('; ')}`;
      })
      .filter((line): line is string => !!line);
    if (appearanceLines.length > 0) {
      lines.push('Spectra plugin appearance cues from plugin CSS/JS:');
      for (const line of appearanceLines) {
        lines.push(`- ${line}`);
      }
    }
  }

  if (mode !== 'compact' && manifest.themes.length > 0) {
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

  if (manifest.resolvedSource && mode !== 'compact') {
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
    const interactiveActivePlugins = activePlugins.filter((plugin) =>
      ['ultimate-addons-for-gutenberg', 'spectra'].includes(plugin.slug),
    );
    if (interactiveActivePlugins.length > 0) {
      lines.push(
        `Resolved active interactive plugins: ${interactiveActivePlugins
          .map((plugin) => plugin.slug)
          .join(', ')}`,
      );
    }
    for (const note of manifest.resolvedSource.notes) {
      lines.push(note);
    }
  }

  for (const note of manifest.sourceOfTruth.notes.slice(
    0,
    mode === 'compact' ? 2 : manifest.sourceOfTruth.notes.length,
  )) {
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
