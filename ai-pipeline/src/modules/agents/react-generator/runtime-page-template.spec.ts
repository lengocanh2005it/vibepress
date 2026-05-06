import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('RuntimePage template source', () => {
  const templatePath = resolve(
    process.cwd(),
    'templates/react-preview/src/pages/RuntimePage.tsx',
  );
  const source = readFileSync(templatePath, 'utf-8');

  it('preserves source wrappers by embedding overlay sections without generic containers', () => {
    expect(source).toContain(
      'const preserveWrapper = binding?.preserveWrapper !== false;',
    );
    expect(source).toContain('embedded: preserveWrapper');
    expect(source).toContain('if (options.embedded) {');
    expect(source).toContain('return <Fragment>{children}</Fragment>;');
  });

  it('avoids injecting fallback max-width shell classes for embedded sections', () => {
    expect(source).toContain("embedded\n      ? ''");
    expect(source).toContain(": 'mx-auto max-w-6xl px-6 py-12';");
  });
});
