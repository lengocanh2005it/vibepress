import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import { summarizeSharedLayoutSubtree } from './shared-layout-subtree.util.js';

describe('summarizeSharedLayoutSubtree', () => {
  it('detects footer-like shared layout signals from inline footer groups', () => {
    const node: WpNode = {
      block: 'group',
      customClassNames: ['pg-footer-center-row'],
      children: [
        {
          block: 'heading',
          text: "Let's Work Together",
        },
        {
          block: 'social-links',
          children: [{ block: 'social-link' }, { block: 'social-link' }],
        },
        {
          block: 'paragraph',
          html: '<p>©Copyright All Right Reserved</p>',
        },
      ],
    };

    const summary = summarizeSharedLayoutSubtree(node);

    expect(summary.hasRouteOwnedContent).toBe(false);
    expect(summary.hasFooterClass).toBe(true);
    expect(summary.socialLinkCount).toBeGreaterThan(0);
    expect(summary.hasCopyrightCopy).toBe(true);
  });

  it('does not mark route-owned query content as shared chrome', () => {
    const node: WpNode = {
      block: 'group',
      customClassNames: ['products-block-post-template'],
      children: [
        {
          block: 'query',
          children: [{ block: 'post-template' }],
        },
      ],
    };

    const summary = summarizeSharedLayoutSubtree(node);

    expect(summary.hasRouteOwnedContent).toBe(true);
    expect(summary.hasCopyrightCopy).toBe(false);
  });
});
