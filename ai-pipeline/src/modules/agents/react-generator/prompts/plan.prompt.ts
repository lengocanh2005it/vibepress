import { readFileSync } from 'fs';
import { join } from 'path';
import { DbContentResult } from '../../../agents/db-content/db-content.service.js';
import { PhpParseResult } from '../../../agents/php-parser/php-parser.service.js';
import { BlockParseResult } from '../../../agents/block-parser/block-parser.service.js';
import type { RepoThemeManifest } from '../../repo-analyzer/repo-analyzer.service.js';
import { buildRepoManifestContextNote } from '../../repo-analyzer/repo-manifest-context.js';

const TEMPLATE = readFileSync(
  join(
    process.cwd(),
    'src/modules/agents/react-generator/prompts/plan.prompt.md',
  ),
  'utf-8',
);

export function buildPlanPrompt(
  theme: PhpParseResult | BlockParseResult,
  content: DbContentResult,
  repoManifest?: RepoThemeManifest,
): string {
  const templateNames =
    theme.type === 'classic'
      ? theme.templates.map((t) => t.name)
      : [...theme.templates, ...theme.parts].map((t) => t.name);

  const base = TEMPLATE.replace('{{siteName}}', content.siteInfo.siteName)
    .replace('{{siteUrl}}', content.siteInfo.siteUrl)
    .replace('{{blogDescription}}', content.siteInfo.blogDescription)
    .replace(
      '{{themeType}}',
      theme.type === 'fse'
        ? 'Full Site Editing (Block theme)'
        : 'Classic PHP theme',
    )
    .replace('{{templateNames}}', templateNames.map((n) => `- ${n}`).join('\n'))
    .replace('{{pageCount}}', String(content.pages.length))
    .replace(
      '{{pages}}',
      content.pages
        .map((p) => `- /${p.slug} (template: ${p.template || 'default'})`)
        .join('\n'),
    )
    .replace(
      '{{menus}}',
      content.menus
        .map((m) => `- ${m.name}: ${m.items.length} items`)
        .join('\n'),
    );

  const repoContext = buildRepoManifestContextNote(repoManifest);
  return repoContext ? `${base}\n\n${repoContext}` : base;
}
