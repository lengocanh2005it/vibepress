import { StyleResolverService } from './style-resolver.service.js';
import type { WpNode } from '../utils/wp-block-to-json.js';

describe('StyleResolverService', () => {
  const service = new StyleResolverService();

  it('resolves plain color slugs and preset color vars to concrete palette values', () => {
    const nodes: WpNode[] = [
      { block: 'group', bgColor: 'base-2' },
      { block: 'group', textColor: 'var:preset|color|contrast' },
      { block: 'group', overlayColor: 'var(--wp--preset--color--accent)' },
    ];

    const resolved = service.resolve(nodes, {
      colors: [
        { slug: 'base-2', value: '#F4F4F4' },
        { slug: 'contrast', value: '#111111' },
        { slug: 'accent', value: '#F5B731' },
      ],
      fonts: [],
      fontSizes: [],
      spacing: [],
    });

    expect(resolved[0]?.bgColor).toBe('#F4F4F4');
    expect(resolved[1]?.textColor).toBe('#111111');
    expect(resolved[2]?.overlayColor).toBe('#F5B731');
  });
});
