import {
  buildSourceMotionBootstrapTs,
  SOURCE_MOTION_BRIDGE_CSS,
} from './preview-bridge-assets.js';

describe('preview source motion bridge assets', () => {
  it('includes sticky-header and scroll-top bridge CSS hooks', () => {
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('#sticky-header');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-scroll-top');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-scroll-top:not(p):not(a):not(button)::before',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.vp-source-reveal');
  });

  it('includes sticky-header and scroll-top runtime bridge logic', () => {
    const bootstrap = buildSourceMotionBootstrapTs();

    expect(bootstrap).toContain(
      "const SOURCE_STICKY_HEADER_SELECTOR = '#sticky-header';",
    );
    expect(bootstrap).toContain(
      "const SOURCE_SCROLL_TOP_SELECTOR = '.profolio-fse-scroll-top';",
    );
    expect(bootstrap).toContain(
      '\'.wow, .animate__animated[class*="animate__"]\';',
    );
    expect(bootstrap).toContain("element.classList.add('vp-source-reveal');");
    expect(bootstrap).toContain(
      'const isEligibleScrollTopElement = (element: HTMLElement) => {',
    );
    expect(bootstrap).toContain(
      'if (structuralTags.has(element.tagName)) return false;',
    );
    expect(bootstrap).toContain('const removeLeakedScrollTopHooks = () => {');
    expect(bootstrap).toContain(
      "element.classList.remove('profolio-fse-scroll-top');",
    );
    expect(bootstrap).toContain(
      "window.scrollTo({ top: 0, behavior: 'smooth' });",
    );
    expect(bootstrap).toContain("element.style.position = 'sticky';");
    expect(bootstrap).toContain('window.scrollY > 100');
  });
});
