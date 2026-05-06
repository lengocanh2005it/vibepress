import { buildCanonicalPagePath } from './wp-page-path.util.js';

describe('buildCanonicalPagePath', () => {
  const pages = [
    { id: 10, slug: 'sample-page', parentId: 0 },
    { id: 11, slug: 'team', parentId: 10 },
    { id: 12, slug: 'senior-swe', parentId: 11 },
  ];

  it('uses the front page as root slash', () => {
    expect(
      buildCanonicalPagePath(pages[0], pages, {
        frontPageId: 10,
      }),
    ).toBe('/');
  });

  it('builds nested page paths from the parent chain', () => {
    expect(buildCanonicalPagePath(pages[2], pages)).toBe(
      '/sample-page/team/senior-swe',
    );
  });
});
