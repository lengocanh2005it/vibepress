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
});
