import { ConfigService } from '@nestjs/config';
import type { ComponentRenderContract } from '../planner/render-contract.schema.js';
import type { ComponentVisualPlan } from '../react-generator/visual-plan.schema.js';
import { ValidatorService } from './validator.service.js';

describe('ValidatorService render-contract coverage', () => {
  const service = new ValidatorService({} as ConfigService);

  const preserveRules: ComponentRenderContract['preserveRules'] = {
    requireFullNodeCoverage: true,
    preserveClassNames: true,
    preserveSpacing: true,
    preserveTypography: true,
    preserveColors: true,
    preserveAlignWideFull: true,
  };

  it('accepts hybrid semantic sections covering source descendants', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/banner.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::2.0.1.0',
            },
            children: [],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'semantic coverage test',
        sections: [
          {
            type: 'media-text',
            heading: 'Welcome To My Profile I am Julia Henderson',
            body: 'About Me',
            imageSrc: 'theme-asset:/assets/images/banner-image.png',
            cta: {
              text: 'View my Work',
              link: '#',
            },
            sourceRef: {
              sourceNodeId: 'front-page::columns::2.0',
            },
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const visualPlan = {
      componentName: 'FrontPage',
      sections: renderContract.fallback?.sections ?? [],
    } as ComponentVisualPlan;

    const code = `
      <section>
        <h2>Welcome To My Profile I am Julia Henderson</h2>
        <p>About Me</p>
        <a href="#">View my Work</a>
        <img src={resolveAsset("theme-asset:/assets/images/banner-image.png")} alt="" />
      </section>
    `;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage(
      code,
      renderContract,
      'FrontPage',
      visualPlan,
    );

    expect(issue).toBeNull();
  });

  it('does not require footer-links for CTA-style footer partials whose plan has no footer link columns', () => {
    const check = (
      service as unknown as {
        checkCodeStructure: (
          code: string,
          context?: {
            componentName?: string;
            dataNeeds?: string[];
            type?: 'page' | 'partial';
            visualPlan?: ComponentVisualPlan;
          },
        ) => { isValid: boolean; error?: string };
      }
    ).checkCodeStructure(
      `
        import React from 'react';

        const Footer: React.FC = () => {
          return (
            <footer>
              <div className="pg-footer-center-row">
                <h2>Let's Work Together</h2>
                <p>CTA footer body</p>
              </div>
            </footer>
          );
        };

        export default Footer;
      `,
      {
        componentName: 'Footer',
        dataNeeds: [],
        type: 'partial',
        visualPlan: {
          componentName: 'Footer',
          sections: [
            {
              type: 'footer',
              menuColumns: [],
            },
          ],
        } as ComponentVisualPlan,
      },
    );

    expect(check.isValid).toBe(true);
    expect(check.error).toBeUndefined();
  });

  it('still reports uncovered hybrid source assets', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/banner.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::2.0.1.0',
            },
            children: [],
          },
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/must-keep.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::9.0.0.0',
            },
            children: [],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'semantic coverage test',
        sections: [
          {
            type: 'media-text',
            heading: 'Welcome To My Profile I am Julia Henderson',
            body: 'About Me',
            imageSrc: 'theme-asset:/assets/images/banner-image.png',
            sourceRef: {
              sourceNodeId: 'front-page::columns::2.0',
            },
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage('<section />', renderContract, 'FrontPage');

    expect(issue).toContain('theme-asset:/assets/images/must-keep.jpg');
  });

  it('does not apply block-tree render coverage to AI section-centric pages', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'heading',
            blockName: 'core/heading',
            text: 'Skills and Tools',
            children: [],
          },
          {
            kind: 'image',
            blockName: 'core/image',
            src: 'theme-asset:/assets/images/figma.png',
            children: [],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'section-centric plan owns source coverage',
        sections: [
          {
            type: 'media-text',
            heading: 'Welcome',
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage(
      '<section><h1>Welcome</h1></section>',
      renderContract,
      'FrontPage',
      {
        componentName: 'FrontPage',
        renderMode: 'section-centric',
        renderAuthority: 'ai',
        sections: [{ type: 'media-text', heading: 'Welcome' }],
      } as ComponentVisualPlan,
    );

    expect(issue).toBeNull();
  });

  it('ignores generic listing labels for hybrid listing surfaces', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'cover',
            blockName: 'core/cover',
            sourceRef: {
              sourceNodeId: 'index::cover::1',
            },
            children: [
              {
                kind: 'heading',
                blockName: 'core/heading',
                text: 'News',
                sourceRef: {
                  sourceNodeId: 'index::heading::1.0',
                },
                children: [],
              },
            ],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: {
              sourceNodeId: 'index::group::2',
            },
            children: [
              {
                kind: 'heading',
                blockName: 'core/heading',
                text: 'Latest Posts',
                sourceRef: {
                  sourceNodeId: 'index::heading::2.0',
                },
                children: [],
              },
            ],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'listing surface coverage test',
        sections: [
          {
            type: 'post-list',
            layout: 'grid-3',
            showDate: true,
            showAuthor: true,
            showCategory: false,
            showExcerpt: true,
            showFeaturedImage: true,
            itemLayout: 'stacked',
            metaLayout: 'inline',
            metaAlign: 'start',
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage(
      '<section><h2>Posts</h2></section>',
      renderContract,
      'Index',
      {
        componentName: 'Index',
        sections: renderContract.fallback?.sections ?? [],
      } as ComponentVisualPlan,
    );

    expect(issue).toBeNull();
  });
});

describe('ValidatorService Woo endpoint guards', () => {
  const service = new ValidatorService({} as ConfigService);

  it('does not treat the products collection endpoint as a product-detail fetch', () => {
    const result = service.checkCodeStructure(
      `
        import { useEffect, useState } from 'react';

        type Product = { slug: string };

        export default function ArchiveProduct() {
          const [products, setProducts] = useState<Product[]>([]);

          useEffect(() => {
            void fetch('/api/post-types/product/posts?page=1&perPage=10')
              .then((res) => res.json())
              .then((data) => setProducts(Array.isArray(data) ? data : []));
          }, []);

          return <section>{products.length}</section>;
        }
      `,
      {
        componentName: 'ArchiveProduct',
        type: 'page',
        dataNeeds: ['products'],
      },
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('ValidatorService derived collection bindings', () => {
  const service = new ValidatorService({} as ConfigService);

  it('accepts sidebar category labels derived from the posts collection', () => {
    const result = service.checkCodeStructure(
      `
        import { useState } from 'react';
        import { Link } from 'react-router-dom';

        export default function BlogRightSidebar() {
          const [posts] = useState<any[]>([]);
          const categoryItems = (() => {
            const map = new Map<string, { slug: string; count: number }>();
            posts.forEach((post) => {
              (post.categories ?? []).forEach((cat, idx) => {
                const slug = post.categorySlugs?.[idx] ?? '';
                const prev = map.get(cat);
                map.set(cat, {
                  slug: prev?.slug || slug,
                  count: (prev?.count ?? 0) + 1,
                });
              });
            });
            return Array.from(map.entries()).map(([name, data]) => ({
              name,
              slug: data.slug,
              count: data.count,
            }));
          })();

          return (
            <section>
              <h3>Popular Categories</h3>
              <ul>
                {categoryItems.map((category) => (
                  <li key={category.slug || category.name}>
                    <Link
                      to={'/category/' + category.slug}
                      className="hover:underline underline-offset-4"
                    >
                      {category.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        }
      `,
      {
        componentName: 'BlogRightSidebar',
        type: 'page',
        dataNeeds: ['posts'],
        visualPlan: {
          componentName: 'BlogRightSidebar',
          sections: [
            {
              type: 'sidebar',
              widgets: [{ kind: 'categories', title: 'Popular Categories' }],
            },
          ],
        } as ComponentVisualPlan,
      },
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts sidebar tag labels derived from the posts collection', () => {
    const result = service.checkCodeStructure(
      `
        import { useState } from 'react';
        import { Link } from 'react-router-dom';

        export default function BlogRightSidebar() {
          const [posts] = useState<any[]>([]);
          const tagItems = (() => {
            const map = new Map<string, number>();
            posts.forEach((post) => {
              (post.tags ?? []).forEach((tag) => {
                const key = String(tag ?? '').trim();
                if (!key) return;
                map.set(key, (map.get(key) ?? 0) + 1);
              });
            });
            return Array.from(map.entries()).map(([name, count]) => ({
              name,
              slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
              count,
            }));
          })();

          return (
            <section>
              <h3>Tags</h3>
              <div>
                {tagItems.map((tag) => (
                  <Link
                    key={tag.slug || tag.name}
                    to={'/tag/' + tag.slug}
                    className="hover:underline underline-offset-4"
                  >
                    {tag.name}
                  </Link>
                ))}
              </div>
            </section>
          );
        }
      `,
      {
        componentName: 'BlogRightSidebar',
        type: 'page',
        dataNeeds: ['posts'],
        visualPlan: {
          componentName: 'BlogRightSidebar',
          sections: [
            {
              type: 'sidebar',
              widgets: [{ kind: 'tags', title: 'Tags' }],
            },
          ],
        } as ComponentVisualPlan,
      },
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts post-terms bindings rendered from metaSource on deterministic detail surfaces', () => {
    const result = service.checkCodeStructure(
      `
        import React from 'react';

        type Product = { tags?: string[]; categories?: string[]; categorySlugs?: string[] };

        export default function SingleProduct() {
          const item: Product | null = null;
          const metaSource: Product | null = item;

          return (
            <section>
              {Array.isArray(metaSource?.tags) && metaSource?.tags.length > 0 ? (
                <div>
                  {metaSource?.tags.map((term, index) => (
                    <React.Fragment key={term + '-' + index}>
                      <span>{term}</span>
                    </React.Fragment>
                  ))}
                </div>
              ) : null}
            </section>
          );
        }
      `,
      {
        componentName: 'SingleProduct',
        type: 'page',
        dataNeeds: [],
        visualPlan: {
          componentName: 'SingleProduct',
          sections: [
            {
              type: 'post-terms',
              taxonomy: 'post_tag',
            },
          ],
        } as ComponentVisualPlan,
      },
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('sanitizes raw theme-asset references before validation', () => {
    const code = service.sanitizeGeneratedCode(`
      import React from 'react';

      const resolveThemeAsset = (src?: string) => {
        if (!src) return '';
        if (src.startsWith('theme-asset:')) return src;
        return src;
      };

      export default function FrontPage() {
        return (
          <section style={{ backgroundImage: "url('theme-asset:/assets/images/banner.jpg')" }}>
            <img src="theme-asset:/assets/images/banner-image.png" alt="" />
          </section>
        );
      }
    `);

    expect(code).toContain('const resolveAsset = (src: string) => {');
    expect(code).toContain(
      'backgroundImage: `url("${resolveAsset("theme-asset:/assets/images/banner.jpg")}")`',
    );
    expect(code).toContain(
      'src={resolveAsset("theme-asset:/assets/images/banner-image.png")}',
    );
    expect(code).toContain('const resolveThemeAsset = (src?: string) => {');
  });

  it('normalizes common sans-serif typos before validation', () => {
    const code = service.sanitizeGeneratedCode(`
      import React from 'react';

      export default function FrontPage() {
        return <h1 style={{ fontFamily: "League Spartan, san-serif" }}>Hello</h1>;
      }
    `);

    expect(code).toContain('League Spartan, sans-serif');
    expect(code).not.toContain('san-serif');
  });

  it('keeps profolio scroll-top hooks only on dedicated trigger elements', () => {
    const code = service.sanitizeGeneratedCode(`
      import React from 'react';

      export default function FrontPage() {
        const html = '<p>Body</p>';
        return (
          <div className="wp-site-blocks flex profolio-fse-scroll-top">
            <section className="profolio-fse-scroll-top hero">
              <div>{html}</div>
            </section>
            <p className="profolio-fse-scroll-top" style={{ margin: 0 }} />
          </div>
        );
      }
    `);

    expect(code).toContain('className="wp-site-blocks flex"');
    expect(code).toContain('className="hero"');
    expect(code).toContain('<p className="profolio-fse-scroll-top"');
    expect(code).not.toContain('wp-site-blocks flex profolio-fse-scroll-top');
    expect(code).not.toContain('profolio-fse-scroll-top hero');
  });

  it('validates page contracts through imported subcomponents', () => {
    const result = service.validate([
      {
        name: 'FrontPage',
        filePath: '',
        route: '/',
        type: 'page',
        code: `
          import FrontPageProjects from '../components/FrontPageProjects';

          export default function FrontPage() {
            return (
              <main className="wp-site-blocks">
                <FrontPageProjects />
              </main>
            );
          }
        `,
        requiredCustomClassNames: ['profolio-fse-projects'],
        visualPlan: {
          componentName: 'FrontPage',
          dataNeeds: [],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [
            {
              type: 'card-grid',
              title: 'My Projects',
              cards: [
                {
                  title: 'AI Based Social Networks',
                  body: 'Design of a mobile app develops',
                },
              ],
            },
          ],
        } as ComponentVisualPlan,
      },
      {
        name: 'FrontPageProjects',
        filePath: '',
        type: 'partial',
        isSubComponent: true,
        code: `
          export default function FrontPageProjects() {
            return (
              <section className="profolio-fse-projects">
                <h2>My Projects</h2>
                <article>
                  <h3>AI Based Social Networks</h3>
                  <p>Design of a mobile app develops</p>
                </article>
              </section>
            );
          }
        `,
      },
    ]);

    expect(result).toHaveLength(2);
  });

  it('rejects direct API calls from subcomponents', () => {
    const result = service.collectValidationIssues([
      {
        name: 'FrontPageProjects',
        filePath: '',
        type: 'partial',
        isSubComponent: true,
        code: `
          import React, { useEffect } from 'react';

          export default function FrontPageProjects() {
            useEffect(() => {
              fetch('/api/posts');
            }, []);

            return <section>Projects</section>;
          }
        `,
      },
    ]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain(
      'Sub-components must not call API endpoints directly',
    );
  });
});
