import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('runtime-plan-builder template source', () => {
  const templatePath = resolve(
    process.cwd(),
    'templates/express-server/runtime/runtime-plan-builder.ts',
  );
  const source = readFileSync(templatePath, 'utf-8');

  it('preserves raw structural blocks for profolio-fse runtime pages', () => {
    expect(source).toContain('preserveSourceStructuralBlocks');
    expect(source).toContain("themeSlug !== 'profolio-fse'");
    expect(source).toContain('shouldPreserveSourceStructuralBlocks');
  });

  it('derives profolio-fse layout families instead of defaulting every page', () => {
    expect(source).toContain('deriveRuntimeLayoutFamily');
    expect(source).toContain("return 'profolio-fse-front-page';");
    expect(source).toContain("return 'profolio-fse-services-page';");
  });

  it('reconstructs runtime layout classes and grid sizing from block attrs', () => {
    expect(source).toContain("collected.add('is-layout-flex')");
    expect(source).toContain("collected.add('is-layout-grid')");
    expect(source).toContain(
      'result.minimumColumnWidth = layout.minimumColumnWidth.trim()',
    );
    expect(source).toContain('result.columns = layout.columnCount');
  });

  it('exports resolved runtime page markup so the API can return render-ready content', () => {
    expect(source).toContain('export function resolveRuntimePageMarkupFromRow');
    expect(source).toContain('expandTemplateMarkup');
    expect(source).toContain('<!--\\s*wp:post-content');
  });

  it('keeps template content slots separate from DB-backed content block trees', () => {
    expect(source).toContain('resolveRuntimeTemplateShellMarkupFromRow');
    expect(source).toContain('preserveContentSlots');
    expect(source).toContain("kind: 'content-slot'");
    expect(source).toContain('contentBlockTree');
  });

  it('returns theme.json tokens for deterministic runtime rendering', () => {
    expect(source).toContain('readRuntimeThemeTokens');
    expect(source).toContain("join(themeDir, 'theme.json')");
    expect(source).toContain('blockStyles: styles.blocks');
    expect(source).toContain(
      'const themeTokens = readRuntimeThemeTokens(themeDir)',
    );
    expect(source).toContain('themeTokens,');
  });

  it('emits detailed runtime DOM, media, width policy, and content-slot contracts', () => {
    expect(source).toContain('extractRuntimeDomSpec');
    expect(source).toContain('extractRuntimeMediaSpec');
    expect(source).toContain('deriveRuntimeWidthPolicy');
    expect(source).toContain("widthPolicy: 'full-bleed'");
    expect(source).toContain("innerWidthPolicy: 'content'");
    expect(source).toContain('findRuntimeContentSlot');
    expect(source).toContain('contentSlot');
  });
});
