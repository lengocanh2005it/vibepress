import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('runtime preview CSS source', () => {
  const cssPath = resolve(process.cwd(), 'templates/react-preview/src/index.css');
  const source = readFileSync(cssPath, 'utf-8');

  it('models profolio-fse root-padding-aware full-width runtime sections', () => {
    expect(source).toContain('--vp-runtime-root-padding-left');
    expect(source).toContain('--wp--style--root--padding-left');
    expect(source).toContain(
      'width: calc(100% + var(--vp-runtime-root-padding-left) + var(--vp-runtime-root-padding-right));',
    );
    expect(source).toContain(
      'margin-left: calc(-1 * var(--vp-runtime-root-padding-left));',
    );
    expect(source).toContain(
      '.runtime-page--theme-profolio-fse .runtime-page__content--structural > .alignfull',
    );
  });

  it('keeps structural default content constrained separately from wide content', () => {
    expect(source).toContain(
      '.runtime-page--theme-profolio-fse .runtime-page__content--structural > .alignwide',
    );
    expect(source).toContain(
      'max-width: var(--wp--style--global--wide-size, 1280px);',
    );
    expect(source).toContain(
      '.runtime-page--theme-profolio-fse .runtime-page__content--structural > :where(:not(.alignfull):not(.alignwide))',
    );
    expect(source).toContain(
      'max-width: var(--wp--style--global--content-size, 1200px);',
    );
  });
});
