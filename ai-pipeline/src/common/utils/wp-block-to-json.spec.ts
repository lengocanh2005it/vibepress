import { wpBlocksToJson } from './wp-block-to-json.js';

function findNode(block: string, markup: string) {
  const nodes = wpBlocksToJson(markup);
  return nodes.find((node) => node.block === block);
}

describe('wpBlocksToJson Spectra blocks', () => {
  it('extracts slider CTA when href appears before class in Spectra markup', () => {
    const slider = findNode(
      'uagb/slider',
      `<!-- wp:uagb/slider {"block_id":"6eebf04a","slideItem":1} -->
<div class="wp-block-uagb-slider uagb-block-6eebf04a uagb-slider-container"><div class="uagb-slides uagb-swiper"><div class="swiper-wrapper"><!-- wp:uagb/slider-child {"block_id":"6f38c6cd"} -->
<div class="wp-block-uagb-slider-child uagb-slider-child-wrap swiper-slide uagb-block-6f38c6cd"><div class="swiper-content"><!-- wp:uagb/container {"block_id":"b6d33271","variationSelected":true,"isBlockRootParent":true} -->
<div class="wp-block-uagb-container uagb-block-b6d33271 alignfull uagb-is-root-container"><div class="uagb-container-inner-blocks-wrap"><!-- wp:uagb/info-box {"classMigrate":true,"block_id":"e5f1e56d","showCtaIcon":false,"ctaType":"button","showIcon":false} -->
<div class="wp-block-uagb-info-box uagb-block-e5f1e56d uagb-infobox__content-wrap"><div class="uagb-ifb-content"><div class="uagb-ifb-title-wrap"><h3 class="uagb-ifb-title">Slide 1</h3></div><p class="uagb-ifb-desc">Slide description</p><div class="uagb-ifb-button-wrapper wp-block-button"><a href="#" class="uagb-infobox-cta-link wp-block-button__link" target="_self" rel="noopener noreferrer" onclick="return false;"><span class="uagb-inline-editing">Read More</span></a></div></div></div>
<!-- /wp:uagb/info-box --></div></div>
<!-- /wp:uagb/container --></div></div>
<!-- /wp:uagb/slider-child --></div></div></div>
<!-- /wp:uagb/slider -->`,
    );

    expect(slider).toEqual({
      block: 'uagb/slider',
      slides: [
        {
          heading: 'Slide 1',
          description: 'Slide description',
          cta: {
            text: 'Read More',
            link: '#',
          },
        },
      ],
    });
  });

  it('extracts modal CTA when href appears before class in Spectra markup', () => {
    const modal = findNode(
      'uagb/modal',
      `<!-- wp:uagb/modal {"block_id":"debb4de0","defaultTemplate":true,"modalAlign":"center"} -->
<div class="wp-block-uagb-modal uagb-block-debb4de0 uagb-modal-wrapper" data-escpress="enable" data-overlayclick="disable"><div class="uagb-spectra-button-wrapper wp-block-button"><a class="uagb-modal-button-link wp-block-button__link uagb-modal-trigger" href="#" onclick="return false;" target="_self" rel="noopener noreferrer"><span class="uagb-modal-content-wrapper"><span class="uagb-inline-editing">Click Here</span></span></a></div><div class="uagb-effect-default uagb-modal-popup uagb-block-debb4de0 uagb-modal-type-undefined"><div class="uagb-modal-popup-wrap"><div class="uagb-modal-popup-content"><!-- wp:uagb/info-box {"classMigrate":true,"block_id":"69ffaac3","showCtaIcon":false,"ctaType":"button","ctaText":"Call To Action"} -->
<div class="wp-block-uagb-info-box uagb-block-69ffaac3 uagb-infobox__content-wrap"><div class="uagb-ifb-content"><div class="uagb-ifb-title-wrap"><h3 class="uagb-ifb-title">Engage Your Visitors!</h3></div><p class="uagb-ifb-desc">Modal description</p><div class="uagb-ifb-button-wrapper wp-block-button"><a href="#" class="uagb-infobox-cta-link wp-block-button__link" target="_self" rel="noopener noreferrer" onclick="return false;"><span class="uagb-inline-editing">Call To Action</span></a></div></div></div>
<!-- /wp:uagb/info-box --></div><button class="uagb-modal-popup-close" aria-label="Close Modal"></button></div></div></div>
<!-- /wp:uagb/modal -->`,
    );

    expect(modal).toEqual({
      block: 'uagb/modal',
      modalTrigger: 'Click Here',
      modalHeading: 'Engage Your Visitors!',
      modalDescription: 'Modal description',
      modalCta: {
        text: 'Call To Action',
        link: '#',
      },
    });
  });
});
