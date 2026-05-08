import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('RuntimePage template source', () => {
  const templatePath = resolve(
    process.cwd(),
    'templates/react-preview/src/pages/RuntimePage.tsx',
  );
  const source = readFileSync(templatePath, 'utf-8');

  it('uses the runtime-page endpoint as the only page data source', () => {
    expect(source).toContain('/api/runtime/pages/${encodeURIComponent(slug)}');
    expect(source).not.toContain('/api/posts?perPage=');
    expect(source).not.toContain('setPosts');
  });

  it('prefers runtimePlan.blockTree for structural rendering while keeping page.content fallback', () => {
    expect(source).toContain('const { page, runtimePlan } = payload;');
    expect(source).toContain(
      'const runtimeContentNodes = selectRuntimeContentNodes(',
    );
    expect(source).toContain('runtimePlan.blockTree');
    expect(source).toContain('runtimePlan.contentBlockTree');
    expect(source).toContain('renderRuntimeNodes(');
    expect(source).toContain('runtimeContentNodes');
    expect(source).toContain("runtimePlan.mode !== 'page-content'");
    expect(source).toContain('renderRichTextChildren(page.content ??');
  });

  it('keeps runtime metadata attributes for preview/edit routing', () => {
    expect(source).toContain('data-runtime-component="RuntimePage"');
    expect(source).toContain("'data-runtime-slug': page.slug");
    expect(source).toContain("'data-runtime-source-kind': sourceKind");
  });

  it('keeps profolio-specific runtime page classes', () => {
    expect(source).toContain('runtime-page--theme-profolio-fse');
  });

  it('wraps simple runtime post content with WordPress/prose spacing classes', () => {
    expect(source).toContain("'core/post-content': ['wp-block-post-content']");
    expect(source).toContain("'runtime-page__content'");
    expect(source).toContain("'wp-block-post-content'");
    expect(source).toContain("'prose'");
    expect(source).toContain("'max-w-none'");
  });

  it('does not force complex Gutenberg content block trees through prose layout', () => {
    expect(source).toContain('function isStructuralRuntimeContent(');
    expect(source).toContain('function isStructuralRuntimeNode(');
    expect(source).toContain("'runtime-page__content--structural'");
    expect(source).toContain("node.layout?.kind === 'constrained'");
    expect(source).toContain("node.align === 'full'");
    expect(source).toContain('isStructuralContent');
  });

  it('trims expanded profolio-fse templates down to content-shell roots before rendering', () => {
    expect(source).toContain('const hasExpandedTemplate = Boolean(');
    expect(source).toContain('function selectRuntimeContentNodes(');
    expect(source).toContain(
      'const profolioContentRoots = blockTree.filter(isProfolioContentRoot);',
    );
    expect(source).toContain("if (node.kind === 'cover') return true;");
  });

  it('renders runtime page HTML through rich-text nodes instead of escaping raw content', () => {
    expect(source).toContain('renderRichTextChildren(page.content ??');
    expect(source).not.toContain('{payload.page.content}');
    expect(source).not.toContain('{page.content}');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toContain('__html');
  });

  it('preserves common WordPress HTML tags, classes, styles, images, and links', () => {
    expect(source).toContain('ALLOWED_TAGS');
    expect(source).toContain('className = element.getAttribute');
    expect(source).toContain('parseStyle(element.getAttribute');
    expect(source).toContain('function renderImage');
    expect(source).toContain('function renderAnchor');
  });

  it('includes recursive runtime block helpers for Gutenberg block trees', () => {
    expect(source).toContain('function renderRuntimeNodes(');
    expect(source).toContain('function renderRuntimeNode(');
    expect(source).toContain('function buildRuntimeNodeProps(');
    expect(source).toContain('function buildRuntimeNodeStyle(');
    expect(source).toContain('function renderRuntimeCover(');
  });

  it('does not force every runtime image to full width', () => {
    expect(source).toContain('function buildRuntimeImageStyle(');
    expect(source).toContain('getRuntimeImageSizeMaxWidth(node)');
    expect(source).toContain("node.align === 'full'");
    expect(source).toContain("node.align === 'wide'");
    expect(source).toContain('node.attrs?.sizeSlug');
    expect(source).toContain('width: shouldStretch');
    expect(source).toContain('maxWidth: shouldStretch');
  });

  it('preserves Gutenberg object border radii on runtime blocks and images', () => {
    expect(source).toContain('function buildRuntimeBorderRadiusStyle(');
    expect(source).toContain('function applyRuntimeBorderRadiusStyle(');
    expect(source).toContain('style.borderTopLeftRadius = topLeft');
    expect(source).toContain('style.borderTopRightRadius = topRight');
    expect(source).toContain('style.borderBottomRightRadius = bottomRight');
    expect(source).toContain('style.borderBottomLeftRadius = bottomLeft');
    expect(source).toContain(
      'node.style?.border?.radius ?? node.style?.borderRadius ?? node.borderRadius',
    );
  });

  it('injects DB-backed content block trees into template content slots', () => {
    expect(source).toContain('const runtimeContentBlockTree = Array.isArray(');
    expect(source).toContain('contentBlockTree.length > 0');
    expect(source).toContain('renderRuntimeNodes(contentBlockTree, page');
  });

  it('keeps Gutenberg column layouts horizontal on desktop while allowing mobile stacking', () => {
    expect(source).toContain("style.flexWrap =");
    expect(source).toContain("?? 'nowrap'");
    expect(source).toContain('style.flex = `0 1 ${width}`');
    expect(source).toContain("style.flex = '1 1 0'");
    expect(source).toContain('style.minWidth = 0');
  });

  it('maps Gutenberg text alignment and vertical flex justification faithfully', () => {
    expect(source).toContain('function getRuntimeTextAlignFromAttrs(');
    expect(source).toContain('node.attrs?.textAlign');
    expect(source).toContain("typeof node.attrs?.align === 'string'");
    expect(source).toContain("layout.orientation === 'vertical'");
    expect(source).toContain('style.alignItems = normalizeJustifyContent(');
  });

  it('applies runtime theme tokens as WordPress CSS variables', () => {
    expect(source).toContain(
      'buildRuntimeThemeStyle(',
    );
    expect(source).toContain('function buildRuntimeThemeStyle(');
    expect(source).toContain('runtimePlan?.layoutPolicy');
    expect(source).toContain('--wp--style--global--content-size');
    expect(source).toContain('--wp--style--root--padding-left');
    expect(source).toContain('--wp--style--root--padding-right');
    expect(source).toContain('--wp--preset--color--');
    expect(source).toContain('--wp--preset--spacing--');
  });

  it('uses runtime layout context to size images inside structural layouts', () => {
    expect(source).toContain('const layoutContext = node.layoutContext ?? {};');
    expect(source).toContain('layoutContext.inColumn === true');
    expect(source).toContain('layoutContext.inGridLayout === true');
    expect(source).toContain('layoutContext.inFlexLayout === true');
    expect(source).toContain("isLayoutBoundImage\n          ? '100%'");
  });

  it('consumes detailed runtime DOM, media, and width policy metadata', () => {
    expect(source).toContain('node.dom?.classNames');
    expect(source).toContain('normalizeRuntimeDomStyle(node.dom?.style)');
    expect(source).toContain('node.media?.width');
    expect(source).toContain('node.media?.aspectRatio');
    expect(source).toContain('node.media?.scale');
    expect(source).toContain('function applyRuntimeWidthPolicy(');
    expect(source).toContain("widthPolicy === 'full-bleed'");
  });
});
