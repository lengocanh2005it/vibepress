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

  it('treats the API page.content as render-ready canonical markup', () => {
    expect(source).toContain('const { page, runtimePlan } = payload;');
    expect(source).toContain('renderRichTextChildren(page.content ??');
    expect(source).not.toContain('runtimePlan.blockTree');
    expect(source).not.toContain('renderRuntimeNodes');
  });

  it('keeps runtime metadata attributes for preview/edit routing', () => {
    expect(source).toContain('data-runtime-component="RuntimePage"');
    expect(source).toContain('data-runtime-slug={page.slug}');
    expect(source).toContain('data-runtime-source-kind={sourceKind}');
  });

  it('keeps profolio-specific runtime page classes', () => {
    expect(source).toContain('runtime-page--theme-profolio-fse');
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
});
