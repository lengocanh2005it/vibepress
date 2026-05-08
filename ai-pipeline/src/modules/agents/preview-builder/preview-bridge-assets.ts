export const SOURCE_MOTION_BRIDGE_CSS = String.raw`@layer components {
  #sticky-header {
    position: sticky;
    top: 0;
    z-index: 999;
    width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    box-sizing: border-box;
    background-color: var(--wp--preset--color--primary, #2F4138) !important;
    border-bottom: 1px solid #4f4f4f !important;
    padding: 20px !important;
  }

  header.wp-site-blocks:has(#sticky-header) {
    position: sticky !important;
    top: 0 !important;
    z-index: 999 !important;
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }

  header.wp-site-blocks:has(> #sticky-header) > #sticky-header {
    position: relative !important;
    top: auto !important;
    z-index: auto !important;
  }

  @media (max-width: 780px) {
    #sticky-header > .wp-block-group {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      justify-content: initial;
      flex-wrap: nowrap !important;
      width: 100% !important;
      max-width: var(--wp--style--global--content-size, 1200px) !important;
      margin-left: auto !important;
      margin-right: auto !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      box-sizing: border-box;
    }

    #sticky-header > .wp-block-group > .wp-block-group:first-child {
      justify-self: start;
      min-width: 0;
    }

    #sticky-header > .wp-block-group > .wp-block-navigation {
      justify-self: center;
    }

    #sticky-header .header-btn,
    #sticky-header .profolio-fse-header-btn {
      display: none !important;
    }

    #sticky-header > .wp-block-group > .wp-block-navigation.hidden {
      display: none !important;
    }

    #sticky-header button[aria-label="Toggle menu"] {
      display: flex !important;
      color: #fff !important;
    }

    #sticky-header > .wp-block-group > .wp-block-navigation.md\:hidden {
      display: block !important;
      position: absolute !important;
      top: 100% !important;
      left: 0 !important;
      right: 0 !important;
      width: 100% !important;
      background: var(--wp--preset--color--primary) !important;
      border-top: 1px solid rgba(255, 255, 255, 0.18);
      border-bottom: 1px solid rgba(255, 255, 255, 0.18);
      z-index: 1000 !important;
    }

    #sticky-header > .wp-block-group > .wp-block-navigation.md\:hidden .wp-block-navigation__container {
      display: flex !important;
      flex-direction: column !important;
      align-items: stretch !important;
      gap: 0 !important;
      padding: 0.75rem 1rem !important;
    }

    #sticky-header > .wp-block-group > .wp-block-navigation.md\:hidden .wp-block-navigation-item__content {
      display: block;
      padding: 0.75rem 0;
      color: #fff !important;
      opacity: 1 !important;
    }
  }

  @media (min-width: 781px) {
    #sticky-header > .wp-block-group {
      display: grid !important;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      column-gap: clamp(24px, 4vw, 56px);
      justify-content: initial;
      flex-wrap: nowrap !important;
      width: 100% !important;
      max-width: var(--wp--style--global--content-size, 1200px) !important;
      margin-left: auto !important;
      margin-right: auto !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      box-sizing: border-box;
    }

    #sticky-header > .wp-block-group > .wp-block-group:first-child {
      justify-self: start;
      min-width: 0;
    }

    #sticky-header .wp-block-navigation {
      min-width: 0;
      justify-self: center;
    }

    #sticky-header .wp-block-navigation__container {
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: nowrap !important;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }

    #sticky-header .wp-block-navigation-item__content,
    #sticky-header .wp-block-navigation a {
      opacity: 1 !important;
      color: var(--wp--preset--color--white, #fff) !important;
      white-space: nowrap;
    }

    #sticky-header .header-btn {
      justify-self: end;
      flex-wrap: nowrap !important;
      white-space: nowrap;
    }

    #sticky-header .header-btn .wp-block-button__link,
    #sticky-header .header-btn a {
      min-width: 0;
      justify-content: center;
      color: #fff !important;
      border-color: #F5B731 !important;
    }
  }

  .profolio-fse-scroll-top {
    display: block !important;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity 320ms ease,
      visibility 320ms ease;
  }

  .profolio-fse-scroll-top.vp-scroll-top-visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }

  .profolio-fse-scroll-top::before {
    opacity: 0;
    transform: translate3d(0, 12px, 0) scale(0.96);
    transition:
      opacity 320ms ease,
      transform 320ms ease;
  }

  .profolio-fse-scroll-top.vp-scroll-top-visible::before {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }

  .profolio-fse-scroll-top:not(p):not(a):not(button)::before {
    content: none !important;
    display: none !important;
  }

  .pg-footer-center-row .wp-block-column {
    display: flex;
    flex-direction: column;
  }

  .pg-footer-center-row .wp-block-column[style*="gap"] {
    row-gap: var(--wp--preset--spacing--10, 1rem);
  }

  .pg-footer-center-row .wp-block-column:last-child {
    row-gap: var(--wp--preset--spacing--10, 1rem);
  }

  footer.wp-site-blocks,
  footer.wp-site-blocks > .wp-block-group {
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    box-sizing: border-box;
  }

  footer .pg-footer-center-row,
  footer .has-base-2-background-color {
    box-sizing: border-box;
  }

  footer .pg-footer-center-row > .wp-block-columns,
  footer .has-base-2-background-color > .wp-block-group {
    width: 100%;
    max-width: var(--wp--style--global--wide-size, 1200px);
    margin-left: auto;
    margin-right: auto;
  }

  @media (max-width: 780px) {
    footer .pg-footer-center-row > .wp-block-columns {
      display: flex !important;
      flex-direction: column !important;
      flex-wrap: nowrap !important;
      row-gap: var(--wp--preset--spacing--30, 2rem) !important;
      padding-top: 56px !important;
      padding-bottom: 56px !important;
    }

    footer .pg-footer-center-row > .wp-block-columns > .wp-block-column {
      flex-basis: 100% !important;
      flex-grow: 1 !important;
      flex-shrink: 1 !important;
      width: 100% !important;
      max-width: 100% !important;
    }

    footer .pg-footer-center-row .wp-block-heading[style*="48px"] {
      font-size: clamp(2rem, 12vw, 3rem) !important;
      line-height: 1.05 !important;
    }

    footer .pg-footer-center-row .wp-block-column:last-child > .wp-block-group {
      padding: 28px !important;
    }

    footer .has-base-2-background-color > .wp-block-group {
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 0.5rem !important;
      text-align: center !important;
    }
  }

  footer .wp-block-social-links,
  footer .wp-block-social-links li,
  footer .wp-block-social-links a {
    color: #F5B731 !important;
  }

  footer .wp-block-social-links i,
  footer .wp-block-social-links svg.wp-social-link-svg {
    color: #F5B731 !important;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1em;
    min-height: 1em;
    width: 1em;
    height: 1em;
    font-style: normal;
    line-height: 1;
  }

  footer .wp-block-social-links .fa-x-twitter::before {
    content: "X";
    color: #F5B731 !important;
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 700;
    font-size: 0.95em;
  }

  .pg-footer-center-row .wp-block-column:last-child > .wp-block-group {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    min-height: 0 !important;
    height: auto !important;
    row-gap: 0.75rem;
  }

  .pg-footer-center-row .wp-block-column:last-child > .wp-block-group > .wp-block-group:last-child {
    display: flex !important;
    justify-content: flex-end !important;
    align-items: flex-end !important;
    width: 100% !important;
    margin-top: auto !important;
  }

  .pg-footer-center-row .wp-block-column:last-child > .wp-block-group figure {
    width: fit-content !important;
    margin: 0 !important;
    margin-left: auto !important;
    align-self: flex-end !important;
  }

  .pg-footer-center-row .wp-block-image.is-resized img[src*="arrow-up"] {
    width: 39px !important;
    max-width: 39px !important;
    height: auto !important;
    margin: 0 !important;
    display: block !important;
  }

  footer p:has(a[href*="themegrove"]),
  footer p:has(a[href*="Themegrove"]),
  footer p:has(a) {
    color: #fff !important;
    font-size: 0.9rem !important;
    line-height: 1.5;
  }

  footer p:has(a[href*="themegrove"]) a,
  footer p:has(a[href*="Themegrove"]) a,
  footer p:has(a) a {
    color: #fff !important;
    font-size: inherit !important;
    font-weight: inherit !important;
    text-decoration: none !important;
  }

  .profolio-fse-banner-wrapper mark {
    background: transparent !important;
    background-color: transparent !important;
    color: #F5B731 !important;
    padding: 0 !important;
  }

  .profolio-fse-banner-wrapper {
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    box-sizing: border-box;
  }

  .profolio-fse-banner-wrapper .wp-block-social-links {
    display: none !important;
  }

  .wp-site-blocks .profolio-fse-banner-wrapper > div[class*="max-w-"][class*="1200px"] {
    padding-left: min(6.5rem, 8vw) !important;
    padding-right: min(6.5rem, 8vw) !important;
    box-sizing: border-box;
  }

  .profolio-fse-banner-wrapper .wp-block-button__link,
  .profolio-fse-banner-wrapper .wp-block-button__link:visited,
  .profolio-fse-banner-wrapper .vp-generated-button,
  .profolio-fse-banner-wrapper .vp-generated-button:visited {
    background-color: #F5B731 !important;
    border-color: #F5B731 !important;
    color: #f2f2f2 !important;
    transition: all 0.3s !important;
  }

  .profolio-fse-banner-wrapper .vp-generated-button *,
  .profolio-fse-banner-wrapper .wp-block-button__link * {
    color: #f2f2f2 !important;
  }

  .profolio-fse-banner-wrapper .wp-block-button__link:hover,
  .profolio-fse-banner-wrapper .wp-block-button__link:focus,
  .profolio-fse-banner-wrapper .vp-generated-button:hover,
  .profolio-fse-banner-wrapper .vp-generated-button:focus {
    background-color: #f58931 !important;
    border-color: #f58931 !important;
    color: #f2f2f2 !important;
  }

  .profolio-fse-banner-wrapper .vp-generated-button:hover *,
  .profolio-fse-banner-wrapper .vp-generated-button:focus *,
  .profolio-fse-banner-wrapper .wp-block-button__link:hover *,
  .profolio-fse-banner-wrapper .wp-block-button__link:focus * {
    color: #f2f2f2 !important;
  }

  .profolio-fse-banner-wrapper .cover-inner {
    padding-top: clamp(12px, 2vw, 28px);
  }

  .profolio-fse-banner-wrapper .r-cover.is-position-bottom-center,
  .profolio-fse-banner-wrapper .r-cover:has(img[src*="banner-image"]) {
    display: flex !important;
    align-items: flex-end !important;
    justify-content: center !important;
  }

  .profolio-fse-banner-wrapper .r-cover.is-position-bottom-center > div:not(:first-child),
  .profolio-fse-banner-wrapper .r-cover:has(img[src*="banner-image"]) > div:not(:first-child),
  .profolio-fse-banner-wrapper .wp-block-cover__inner-container {
    width: 100% !important;
    display: flex !important;
    justify-content: center !important;
    align-items: flex-end !important;
    text-align: center !important;
  }

  .profolio-fse-banner-wrapper img[src*="banner-image"],
  .profolio-fse-banner-wrapper .profolio-fse-banner-image {
    display: block !important;
    margin-left: auto !important;
    margin-right: auto !important;
    object-fit: contain !important;
  }

  .profolio-fse-banner-wrapper .cover-inner.wow,
  .profolio-fse-banner-wrapper .cover-inner.vp-source-reveal {
    --vp-wow-distance: 38px;
    --vp-wow-duration: 820ms;
  }

  .profolio-fse-projects-wrapper {
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    box-sizing: border-box;
  }

  .profolio-fse-projects-wrapper .profolio-fse-project-card,
  .profolio-fse-projects-wrapper .profolio-fse-project-card-title,
  .profolio-fse-projects-wrapper .profolio-fse-project-card-body,
  main.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section,
  .wp-site-blocks > .r-pad [style*="grid-template-columns"] > section,
  main.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section h3,
  .wp-site-blocks > .r-pad [style*="grid-template-columns"] > section h3,
  main.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section p,
  .wp-site-blocks > .r-pad [style*="grid-template-columns"] > section p {
    text-align: left !important;
  }

  .profolio-fse-project-card,
  main.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section,
  .wp-site-blocks > .r-pad [style*="grid-template-columns"] > section {
    --vp-wow-distance: 34px;
    --vp-wow-duration: 760ms;
  }

  .profolio-fse-projects-wrapper .r-cover,
  main.wp-site-blocks > .r-pad .r-cover,
  .wp-site-blocks > .r-pad .r-cover {
    position: relative !important;
    overflow: hidden;
  }

  .profolio-fse-project-arrow,
  .profolio-fse-projects-wrapper .r-cover div:has(> img[src*="arrow-up"]),
  main.wp-site-blocks > .r-pad .r-cover div:has(> img[src*="arrow-up"]),
  .wp-site-blocks > .r-pad .r-cover div:has(> img[src*="arrow-up"]) {
    position: absolute !important;
    top: 1em !important;
    right: 1em !important;
    z-index: 2;
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    width: auto !important;
    margin: 0 !important;
    background-color: #F5B731 !important;
    border-radius: 5px !important;
    padding: 5px 10px !important;
  }

  .profolio-fse-project-arrow img,
  .profolio-fse-projects-wrapper .r-cover img[src*="arrow-up"],
  main.wp-site-blocks > .r-pad .r-cover img[src*="arrow-up"],
  .wp-site-blocks > .r-pad .r-cover img[src*="arrow-up"] {
    width: 20px !important;
    max-width: 20px !important;
    height: auto !important;
  }

  .profolio-fse-services-wrapper,
  main.wp-site-blocks > .r-pad > .cover-inner,
  .wp-site-blocks > .r-pad > .cover-inner {
    width: 100%;
  }

  .profolio-fse-services-stack,
  main.wp-site-blocks > .r-pad > .cover-inner,
  .wp-site-blocks > .r-pad > .cover-inner {
    display: flex !important;
    flex-direction: column !important;
    gap: 24px !important;
  }

  .profolio-fse-service-card,
  main.wp-site-blocks > .r-pad > .cover-inner > section,
  .wp-site-blocks > .r-pad > .cover-inner > section {
    margin-bottom: 0 !important;
    padding-top: 48px !important;
    --vp-wow-distance: 34px;
    --vp-wow-duration: 760ms;
  }

  .profolio-fse-service-card-copy,
  main.wp-site-blocks > .r-pad > .cover-inner > section [style*="padding-top: 0px"],
  .wp-site-blocks > .r-pad > .cover-inner > section [style*="padding-top: 0px"] {
    padding-top: 8px !important;
  }

  .profolio-fse-services-wrapper .profolio-fse-service-card-media,
  .profolio-fse-services-wrapper .profolio-fse-service-card .r-cover,
  .profolio-fse-services-wrapper .profolio-fse-service-card .r-cover.is-style-outline,
  main.wp-site-blocks > .r-pad > .cover-inner > section .r-cover,
  .wp-site-blocks > .r-pad > .cover-inner > section .r-cover {
    border: 0 !important;
    border-width: 0 !important;
    border-color: transparent !important;
    outline: 0 !important;
    box-shadow: none !important;
  }

  .profolio-fse-services-wrapper .wp-block-button__link:not(.is-style-outline),
  .profolio-fse-services-wrapper .wp-element-button:not(.is-style-outline),
  .profolio-fse-services-wrapper .vp-generated-button:not(.is-style-outline) {
    background-color: #F5B731 !important;
    border-color: #F5B731 !important;
    color: #f2f2f2 !important;
    transition: all 0.3s !important;
  }

  .profolio-fse-services-wrapper .wp-block-button__link:not(.is-style-outline):hover,
  .profolio-fse-services-wrapper .wp-block-button__link:not(.is-style-outline):focus,
  .profolio-fse-services-wrapper .wp-element-button:not(.is-style-outline):hover,
  .profolio-fse-services-wrapper .wp-element-button:not(.is-style-outline):focus,
  .profolio-fse-services-wrapper .vp-generated-button:not(.is-style-outline):hover,
  .profolio-fse-services-wrapper .vp-generated-button:not(.is-style-outline):focus {
    background-color: #f58931 !important;
    border-color: #f58931 !important;
    color: #f2f2f2 !important;
  }

  .profolio-fse-services-wrapper .wp-block-button.is-style-outline .wp-block-button__link,
  .profolio-fse-services-wrapper .wp-block-button__link.is-style-outline,
  .profolio-fse-services-wrapper .wp-element-button.is-style-outline,
  .profolio-fse-services-wrapper .vp-generated-button.is-style-outline {
    background-color: transparent !important;
    border-color: #2F4138 !important;
    color: #2F4138 !important;
    transition: all 0.3s !important;
  }

  .profolio-fse-services-wrapper .wp-block-button.is-style-outline .wp-block-button__link:hover,
  .profolio-fse-services-wrapper .wp-block-button.is-style-outline .wp-block-button__link:focus,
  .profolio-fse-services-wrapper .wp-block-button__link.is-style-outline:hover,
  .profolio-fse-services-wrapper .wp-block-button__link.is-style-outline:focus,
  .profolio-fse-services-wrapper .wp-element-button.is-style-outline:hover,
  .profolio-fse-services-wrapper .wp-element-button.is-style-outline:focus,
  .profolio-fse-services-wrapper .vp-generated-button.is-style-outline:hover,
  .profolio-fse-services-wrapper .vp-generated-button.is-style-outline:focus {
    background-color: #f58931 !important;
    border-color: #f58931 !important;
    color: #f2f2f2 !important;
  }

  .profolio-fse-experience-wrapper,
  main.wp-site-blocks > .r-pad.has-secondary-background-color,
  .wp-site-blocks > .r-pad.has-secondary-background-color {
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    padding-top: 80px !important;
    padding-right: 20px !important;
    padding-bottom: 80px !important;
    padding-left: 20px !important;
    box-sizing: border-box;
    text-align: left !important;
  }

  .profolio-fse-experience-wrapper .profolio-fse-experience-columns,
  .profolio-fse-experience-wrapper .profolio-fse-experience-copy,
  .profolio-fse-experience-wrapper .profolio-fse-experience-copy *,
  main.wp-site-blocks > .r-pad.has-secondary-background-color [class*="vp-section-align"],
  .wp-site-blocks > .r-pad.has-secondary-background-color [class*="vp-section-align"],
  main.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner,
  .wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner,
  main.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner *,
  .wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner * {
    text-align: left !important;
    justify-content: flex-start !important;
  }

  .profolio-fse-experience-copy,
  main.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner,
  .wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner {
    --vp-wow-distance: 38px;
    --vp-wow-duration: 820ms;
  }

  .profolio-fse-experience-image,
  main.wp-site-blocks > .r-pad.has-secondary-background-color .r-cover,
  .wp-site-blocks > .r-pad.has-secondary-background-color .r-cover {
    background-size: cover !important;
    background-repeat: no-repeat !important;
    overflow: hidden;
  }

  .profolio-fse-experience-image > :first-child:not(img),
  main.wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > :first-child:not(img),
  .wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > :first-child:not(img) {
    opacity: 0 !important;
    background-color: transparent !important;
    pointer-events: none;
  }

  .profolio-fse-experience-image > div[style*="background-color"],
  .profolio-fse-experience-image > span[class*="has-background-dim"],
  main.wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > div[style*="background-color"],
  main.wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > span[class*="has-background-dim"],
  .wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > div[style*="background-color"],
  .wp-site-blocks > .r-pad.has-secondary-background-color .r-cover > span[class*="has-background-dim"] {
    opacity: 0 !important;
    background-color: transparent !important;
    pointer-events: none;
  }

  .profolio-fse-skills-wrapper,
  [data-source-node-id="front-page::group::1.3"] {
    width: 100vw !important;
    max-width: 100vw !important;
    margin-left: calc(50% - 50vw) !important;
    margin-right: calc(50% - 50vw) !important;
    box-sizing: border-box;
  }

  .profolio-fse-skills-grid,
  [data-source-node-id="front-page::group::1.3.1"] {
    display: grid !important;
    grid-template-columns: repeat(5, minmax(112px, 1fr)) !important;
    justify-content: center !important;
    justify-items: center !important;
    gap: 24px !important;
  }

  .profolio-fse-skill-card,
  [data-source-node-id="front-page::group::1.3.1"] > div {
    width: 100% !important;
    max-width: 180px !important;
    min-width: 0 !important;
    text-align: center !important;
    --vp-wow-scale: 0;
    --vp-wow-duration: 760ms;
  }

  .profolio-fse-skill-card img,
  .profolio-fse-skill-icon,
  [data-source-node-id="front-page::group::1.3.1"] > div > img {
    display: block !important;
    margin-left: auto !important;
    margin-right: auto !important;
    width: 80px !important;
    max-width: 80px !important;
    height: auto !important;
  }

  @media (max-width: 900px) {
    .profolio-fse-skills-grid,
    [data-source-node-id="front-page::group::1.3.1"] {
      grid-template-columns: repeat(3, minmax(112px, 1fr)) !important;
    }
  }

  @media (max-width: 560px) {
    .profolio-fse-skills-grid,
    [data-source-node-id="front-page::group::1.3.1"] {
      grid-template-columns: repeat(2, minmax(112px, 1fr)) !important;
    }
  }

  .wow,
  .vp-source-reveal {
    will-change: opacity, transform;
    backface-visibility: hidden;
    transform-origin: center center;
    --vp-wow-distance: 24px;
    --vp-wow-scale: 0.92;
    --vp-wow-duration: 700ms;
    --vp-wow-delay: 0ms;
    --vp-wow-timing: ease;
  }

  .wow.animate__animated,
  .vp-source-reveal.animate__animated {
    animation: none !important;
    opacity: 0;
    transition-property: opacity, transform;
    transition-duration: var(--vp-wow-duration);
    transition-delay: var(--vp-wow-delay);
    transition-timing-function: var(--vp-wow-timing);
  }

  .wow.animate__animated.vp-wow-visible,
  .wow.vp-wow-visible,
  .vp-source-reveal.animate__animated.vp-wow-visible,
  .vp-source-reveal.vp-wow-visible {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1) rotate(0deg);
  }

  .wow.animate__fadeIn,
  .vp-source-reveal.animate__fadeIn {
    transform: translate3d(0, 0, 0);
  }

  .wow.animate__fadeInUp,
  .wow.animate__fadeInUpBig,
  .wow.animate__slideInUp,
  .wow.animate__bounceInUp,
  .vp-source-reveal.animate__fadeInUp,
  .vp-source-reveal.animate__fadeInUpBig,
  .vp-source-reveal.animate__slideInUp,
  .vp-source-reveal.animate__bounceInUp {
    transform: translate3d(0, var(--vp-wow-distance), 0);
  }

  .wow.animate__fadeInDown,
  .wow.animate__fadeInDownBig,
  .wow.animate__slideInDown,
  .wow.animate__bounceInDown,
  .vp-source-reveal.animate__fadeInDown,
  .vp-source-reveal.animate__fadeInDownBig,
  .vp-source-reveal.animate__slideInDown,
  .vp-source-reveal.animate__bounceInDown {
    transform: translate3d(0, calc(var(--vp-wow-distance) * -1), 0);
  }

  .wow.animate__fadeInLeft,
  .wow.animate__fadeInLeftBig,
  .wow.animate__slideInLeft,
  .wow.animate__bounceInLeft,
  .vp-source-reveal.animate__fadeInLeft,
  .vp-source-reveal.animate__fadeInLeftBig,
  .vp-source-reveal.animate__slideInLeft,
  .vp-source-reveal.animate__bounceInLeft {
    transform: translate3d(calc(var(--vp-wow-distance) * -1), 0, 0);
  }

  .wow.animate__fadeInRight,
  .wow.animate__fadeInRightBig,
  .wow.animate__slideInRight,
  .wow.animate__bounceInRight,
  .vp-source-reveal.animate__fadeInRight,
  .vp-source-reveal.animate__fadeInRightBig,
  .vp-source-reveal.animate__slideInRight,
  .vp-source-reveal.animate__bounceInRight {
    transform: translate3d(var(--vp-wow-distance), 0, 0);
  }

  .wow.animate__zoomIn,
  .wow.animate__zoomInDown,
  .wow.animate__zoomInUp,
  .wow.animate__zoomInLeft,
  .wow.animate__zoomInRight,
  .wow.animate__bounceIn,
  .vp-source-reveal.animate__zoomIn,
  .vp-source-reveal.animate__zoomInDown,
  .vp-source-reveal.animate__zoomInUp,
  .vp-source-reveal.animate__zoomInLeft,
  .vp-source-reveal.animate__zoomInRight,
  .vp-source-reveal.animate__bounceIn {
    transform: scale(var(--vp-wow-scale));
  }

  .wow.animate__flipInX,
  .vp-source-reveal.animate__flipInX {
    transform: perspective(900px) rotateX(-12deg);
  }

  .wow.animate__flipInY,
  .vp-source-reveal.animate__flipInY {
    transform: perspective(900px) rotateY(-12deg);
  }

  .wow.animate__fast,
  .vp-source-reveal.animate__fast {
    --vp-wow-duration: 560ms;
  }

  .wow.animate__faster,
  .vp-source-reveal.animate__faster {
    --vp-wow-duration: 420ms;
  }

  .wow.animate__slow,
  .vp-source-reveal.animate__slow {
    --vp-wow-duration: 900ms;
  }

  .wow.animate__slower,
  .vp-source-reveal.animate__slower {
    --vp-wow-duration: 1200ms;
  }

  .wow.animate__delay-500ms,
  .vp-source-reveal.animate__delay-500ms {
    --vp-wow-delay: 500ms;
  }

  .wow.animate__delay-1s,
  .vp-source-reveal.animate__delay-1s {
    --vp-wow-delay: 1s;
  }

  .wow.animate__delay-2s,
  .vp-source-reveal.animate__delay-2s {
    --vp-wow-delay: 2s;
  }

  .wow.animate__delay-3s,
  .vp-source-reveal.animate__delay-3s {
    --vp-wow-delay: 3s;
  }

  .wow.animate__delay-4s,
  .vp-source-reveal.animate__delay-4s {
    --vp-wow-delay: 4s;
  }

  .wow.animate__delay-5s,
  .vp-source-reveal.animate__delay-5s {
    --vp-wow-delay: 5s;
  }
  @media (prefers-reduced-motion: reduce) {
    .wow,
    .vp-source-reveal,
    .wow.animate__animated,
    .vp-source-reveal.animate__animated,
    .wow.animate__fadeInUp,
    .wow.animate__fadeInUpBig,
    .wow.animate__fadeInDown,
    .wow.animate__fadeInDownBig,
    .wow.animate__fadeInLeft,
    .wow.animate__fadeInLeftBig,
    .wow.animate__fadeInRight,
    .wow.animate__fadeInRightBig,
    .wow.animate__slideInUp,
    .wow.animate__slideInDown,
    .wow.animate__slideInLeft,
    .wow.animate__slideInRight,
    .wow.animate__zoomIn,
    .vp-source-reveal.animate__fadeInUp,
    .vp-source-reveal.animate__fadeInUpBig,
    .vp-source-reveal.animate__fadeInDown,
    .vp-source-reveal.animate__fadeInDownBig,
    .vp-source-reveal.animate__fadeInLeft,
    .vp-source-reveal.animate__fadeInLeftBig,
    .vp-source-reveal.animate__fadeInRight,
    .vp-source-reveal.animate__fadeInRightBig,
    .vp-source-reveal.animate__slideInUp,
    .vp-source-reveal.animate__slideInDown,
    .vp-source-reveal.animate__slideInLeft,
    .vp-source-reveal.animate__slideInRight,
    .vp-source-reveal.animate__zoomIn {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }
}
`;

export function buildSourceMotionBootstrapTs(): string {
  return String.raw`const SOURCE_MOTION_SELECTOR =
  '.wow, .animate__animated[class*="animate__"], ' +
  '.profolio-fse-banner-wrapper, .profolio-fse-projects-wrapper, ' +
  '.profolio-fse-services-wrapper, .profolio-fse-experience-wrapper, ' +
  '.profolio-fse-skills-wrapper, [data-source-node-id^="front-page::"]';
const SOURCE_STICKY_HEADER_SELECTOR = '#sticky-header';
const SOURCE_SCROLL_TOP_SELECTOR = '.profolio-fse-scroll-top';
const SOURCE_THEME_INTERACTION_SELECTOR =
  SOURCE_STICKY_HEADER_SELECTOR + ', ' + SOURCE_SCROLL_TOP_SELECTOR;

function startSourceMotionBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const reduceMotion = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  const pendingActivations = new Set<HTMLElement>();

  const activate = (element: HTMLElement) => {
    pendingActivations.delete(element);
    element.classList.add('vp-wow-visible');
  };

  const scheduleActivate = (element: HTMLElement) => {
    if (
      element.classList.contains('vp-wow-visible') ||
      pendingActivations.has(element)
    ) {
      return;
    }

    pendingActivations.add(element);
    const nextFrame = (callback: () => void) => {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(callback);
        return;
      }
      window.setTimeout(callback, 16);
    };

    nextFrame(() => nextFrame(() => activate(element)));
  };

  const isSourceRevealCandidate = (element: HTMLElement) => {
    if (element.classList.contains('wow')) return true;
    if (!element.classList.contains('animate__animated')) return false;
    return Array.from(element.classList).some(
      (className) =>
        className.startsWith('animate__') && className !== 'animate__animated',
    );
  };

  const hydrateProfolioRevealCards = (root: ParentNode) => {
    const nestedMotionClasses = [
      'wow',
      'vp-source-reveal',
      'vp-wow-visible',
      'animate__animated',
      'animate__fadeIn',
      'animate__fadeInUp',
      'animate__fadeInUpBig',
      'animate__slideInUp',
      'animate__bounceInUp',
    ];
    const suppressNestedProjectServiceMotion = (scope: ParentNode) => {
      const suppressed: HTMLElement[] = [];
      if (
        scope instanceof HTMLElement &&
        scope.matches(
          '.profolio-fse-projects-grid > .profolio-fse-project-card, ' +
            '.profolio-fse-services-stack > .profolio-fse-service-card, ' +
            '.profolio-fse-services-stack > section',
        )
      ) {
        suppressed.push(scope);
      }
      scope
        .querySelectorAll?.<HTMLElement>(
          '.profolio-fse-projects-grid > .profolio-fse-project-card, ' +
            '.profolio-fse-services-stack > .profolio-fse-service-card, ' +
            '.profolio-fse-services-stack > section',
        )
        .forEach((element) => suppressed.push(element));
      suppressed.forEach((element) => {
          nestedMotionClasses.forEach((className) =>
            element.classList.remove(className),
          );
          element.style.removeProperty('--vp-wow-delay');
          element.style.removeProperty('--vp-wow-distance');
          element.style.removeProperty('--vp-wow-duration');
          delete element.dataset.vpWowObserved;
        });
    };
    suppressNestedProjectServiceMotion(root);

    const selector =
      '.profolio-fse-banner-wrapper .cover-inner, ' +
      '.profolio-fse-projects-wrapper .profolio-fse-projects-grid, ' +
      '.profolio-fse-projects-wrapper [style*="grid-template-columns"] > section, ' +
      'main.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section, ' +
      '.wp-site-blocks > .r-pad [style*="grid-template-columns"] > section, ' +
      '.profolio-fse-services-wrapper .profolio-fse-services-stack, ' +
      'main.wp-site-blocks > .r-pad > .cover-inner > section, ' +
      '.wp-site-blocks > .r-pad > .cover-inner > section, ' +
      '.profolio-fse-experience-wrapper .profolio-fse-experience-copy, ' +
      'main.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner, ' +
      '.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner, ' +
      '.profolio-fse-skills-wrapper .profolio-fse-skill-card, ' +
      '.profolio-fse-skills-grid > div, ' +
      '.profolio-fse-skills-grid > section, ' +
      '.profolio-fse-skills-grid > article, ' +
      '[data-source-node-id="front-page::group::1.3.1"] > div';
    const candidates: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(selector)) {
      candidates.push(root);
    }
    root
      .querySelectorAll?.<HTMLElement>(selector)
      .forEach((element) => candidates.push(element));

    let skillIndex = -1;
    candidates.forEach((element, index) => {
      element.classList.add(
        'vp-source-reveal',
        'animate__animated',
      );
      const isSkillCard =
        element.classList.contains('profolio-fse-skill-card') ||
        element.parentElement?.classList.contains('profolio-fse-skills-grid') ||
        element.parentElement?.getAttribute('data-source-node-id') ===
          'front-page::group::1.3.1';
      if (isSkillCard) {
        [
          'animate__fadeIn',
          'animate__fadeInUp',
          'animate__fadeInUpBig',
          'animate__slideInUp',
          'animate__bounceInUp',
          'animate__fadeInDown',
          'animate__fadeInLeft',
          'animate__fadeInRight',
        ].forEach((className) => element.classList.remove(className));
        skillIndex += 1;
        element.classList.add('animate__zoomIn');
        if (skillIndex === 1 || skillIndex === 3) {
          element.classList.add('animate__delay-1s');
        }
        element.style.setProperty('--vp-wow-scale', '0');
        element.style.setProperty(
          '--vp-wow-delay',
          skillIndex === 1 || skillIndex === 3 ? '1s' : '0ms',
        );
        return;
      }

      element.classList.add('animate__fadeInUp');
      element.style.setProperty(
        '--vp-wow-delay',
        String(Math.min(index, 3) * 110) + 'ms',
      );
    });
  };

  const register = (
    element: HTMLElement,
    observer?: IntersectionObserver,
  ) => {
    if (!isSourceRevealCandidate(element) || element.dataset.vpWowObserved === '1')
      return;

    element.dataset.vpWowObserved = '1';
    if (!element.classList.contains('wow')) {
      element.classList.add('vp-source-reveal');
    }

    if (reduceMotion || !observer) {
      activate(element);
      return;
    }

    observer.observe(element);
  };

  const scan = (root: ParentNode, observer?: IntersectionObserver) => {
    hydrateProfolioRevealCards(root);
    if (root instanceof HTMLElement) {
      register(root, observer);
    }
    root
      .querySelectorAll?.<HTMLElement>('.wow, .animate__animated')
      .forEach((element) => register(element, observer));
  };

  if (reduceMotion || typeof IntersectionObserver === 'undefined') {
    scan(document, undefined);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target;
        if (element instanceof HTMLElement) {
          scheduleActivate(element);
          observer.unobserve(element);
        }
      }
    },
    {
      threshold: 0.16,
      rootMargin: '0px 0px -8% 0px',
    },
  );

  scan(document, observer);

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        scan(node, observer);
      }
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener(
    'beforeunload',
    () => {
      mutationObserver.disconnect();
      observer.disconnect();
    },
    { once: true },
  );
}

function startSourceThemeInteractionBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const applyStickyHeader = () => {
    document
      .querySelectorAll<HTMLElement>(SOURCE_STICKY_HEADER_SELECTOR)
      .forEach((element) => {
        element.style.position = 'sticky';
        element.style.top = '0';
        if (!element.style.zIndex) {
          element.style.zIndex = '999';
        }
      });
  };

  const bindScrollTop = (element: HTMLElement) => {
    if (element.dataset.vpScrollTopBound === '1') return;
    element.dataset.vpScrollTopBound = '1';
    element.addEventListener('click', (event) => {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const isEligibleScrollTopElement = (element: HTMLElement) => {
    const structuralTags = new Set([
      'MAIN',
      'HEADER',
      'FOOTER',
      'SECTION',
      'ARTICLE',
      'NAV',
      'ASIDE',
    ]);
    if (structuralTags.has(element.tagName)) return false;
    if (
      element.childElementCount > 0 &&
      element.tagName !== 'A' &&
      element.tagName !== 'BUTTON'
    ) {
      return false;
    }
    return true;
  };

  const getScrollTopElements = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(SOURCE_SCROLL_TOP_SELECTOR),
    ).filter((element) => isEligibleScrollTopElement(element));

  const removeLeakedScrollTopHooks = () => {
    document
      .querySelectorAll<HTMLElement>(SOURCE_SCROLL_TOP_SELECTOR)
      .forEach((element) => {
        if (isEligibleScrollTopElement(element)) return;
        element.classList.remove('profolio-fse-scroll-top');
        element.removeAttribute('data-vp-scroll-top-bound');
      });
  };

  const shouldShowScrollTop = () => {
    const doc = document.documentElement;
    const body = document.body;
    const documentHeight = Math.max(
      doc.scrollHeight,
      body.scrollHeight,
      doc.offsetHeight,
      body.offsetHeight,
      doc.clientHeight,
    );
    const viewportHeight = window.innerHeight || doc.clientHeight || 1;
    const maxScroll = Math.max(0, documentHeight - viewportHeight);
    if (maxScroll <= 0) return false;

    const scrollY = Math.max(0, window.scrollY || window.pageYOffset || 0);
    const footer = document.querySelector('footer');
    const footerNearViewport =
      footer instanceof HTMLElement &&
      footer.getBoundingClientRect().top <= viewportHeight * 1.15;
    const progressThreshold = Math.min(maxScroll, Math.max(72, viewportHeight * 0.18));
    const nearBottom = scrollY + viewportHeight >= documentHeight - viewportHeight * 0.75;

    return footerNearViewport || nearBottom || scrollY >= progressThreshold;
  };

  const updateScrollTopVisibility = () => {
    removeLeakedScrollTopHooks();
    const shouldShow = shouldShowScrollTop();
    for (const element of getScrollTopElements()) {
      bindScrollTop(element);
      element.classList.toggle('vp-scroll-top-visible', shouldShow);
      element.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
      if (element.tabIndex < 0 && shouldShow) {
        element.tabIndex = 0;
      }
      if (!shouldShow) {
        element.tabIndex = -1;
      }
    }
  };

  const handleScroll = () => {
    updateScrollTopVisibility();
  };

  applyStickyHeader();
  updateScrollTopVisibility();
  window.addEventListener('scroll', handleScroll, { passive: true });

  const mutationObserver = new MutationObserver(() => {
    applyStickyHeader();
    updateScrollTopVisibility();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener(
    'beforeunload',
    () => {
      window.removeEventListener('scroll', handleScroll);
      mutationObserver.disconnect();
    },
    { once: true },
  );
}

export function watchForSourceMotionSignals() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let started = false;
  let signalObserver: MutationObserver | null = null;

  const boot = () => {
    if (started) return;
    started = true;
    signalObserver?.disconnect();
    startSourceMotionBridge();
    startSourceThemeInteractionBridge();
  };

  const hasSignal = () =>
    !!document.querySelector<HTMLElement>(SOURCE_MOTION_SELECTOR) ||
    !!document.querySelector<HTMLElement>(SOURCE_THEME_INTERACTION_SELECTOR);

  const check = () => {
    if (!hasSignal()) return;
    boot();
  };

  check();
  if (started) return;

  signalObserver = new MutationObserver(() => {
    check();
  });

  signalObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  window.addEventListener(
    'beforeunload',
    () => {
      signalObserver?.disconnect();
    },
    { once: true },
  );

  window.requestAnimationFrame(check);
}
`;
}

export const SPECTRA_COMPAT_CSS = String.raw`@layer components {
  body.hide-scroll {
    overflow: hidden;
  }

  /* WordPress is-style-asterisk card grid decoration */
  .is-style-asterisk > span.is-style-asterisk {
    display: block;
    font-size: 1.5rem;
    line-height: 1;
    margin-bottom: 0.5rem;
    color: inherit;
    opacity: 0.7;
  }

  .uagb-modal-wrapper {
    width: 100%;
  }

  .uagb-modal-trigger.uagb-modal-button-link {
    text-decoration: none;
    align-items: center;
    cursor: pointer;
  }

  .uagb-modal-popup {
    visibility: hidden;
    position: fixed;
  }

  .uagb-modal-popup.active {
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    visibility: visible;
  }

  .uagb-modal-popup .uagb-modal-popup-wrap {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    max-width: 100%;
    position: relative;
    box-sizing: border-box;
  }

  .uagb-effect-default .uagb-modal-popup-wrap {
    opacity: 0;
  }

  .uagb-effect-default.active .uagb-modal-popup-wrap {
    opacity: 1;
    transition: all 0.3s;
  }

  .uagb-modal-popup .uagb-modal-popup-content {
    overflow-x: hidden;
    overflow-y: auto;
    height: 100%;
  }

  .uagb-modal-popup .uagb-modal-popup-close {
    display: none;
    border: none;
    background: transparent;
    padding: 0;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close {
    display: flex;
    align-items: center;
    opacity: 1;
    cursor: pointer;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close svg {
    transition-property: filter, transform;
    transition-duration: 250ms;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close:focus svg {
    transform: scale(1.2);
  }

  .uagb-modal-trigger:not(img) {
    display: flex;
  }

  img.uagb-modal-trigger {
    cursor: pointer;
    height: auto;
    max-width: 100%;
  }

  .uagb-spectra-button-wrapper {
    line-height: 1;
  }

  .uagb-spectra-button-wrapper .uagb-modal-button-link.uagb-modal-trigger {
    display: inline-flex;
    align-items: center;
  }

  .vp-uagb-modal__stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  .vp-uagb-modal__intro {
    max-width: 42rem;
  }

  .vp-uagb-modal__image-frame {
    position: relative;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.06);
  }

  .vp-uagb-modal-popup {
    z-index: 90;
    padding: 1rem;
  }

  .vp-uagb-modal-popup__wrap {
    width: 100%;
    background: #ffffff;
  }

  .vp-uagb-modal-popup__close {
    position: absolute;
    z-index: 10;
    width: 25px;
    height: 25px;
    justify-content: center;
    color: #ffffff;
  }

  .vp-uagb-modal__content-grid {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .vp-uagb-modal__content-grid--split {
    display: grid;
    gap: 2rem;
  }

  .vp-uagb-modal__content-stack {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  @media (min-width: 640px) {
    .vp-uagb-modal-popup {
      padding-top: 2rem;
      padding-bottom: 2rem;
    }
  }

  @media (min-width: 1024px) {
    .vp-uagb-modal__content-grid--split {
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.88fr);
      align-items: center;
    }
  }

  .uagb-tabs__wrap {
    display: flex;
    width: 100%;
  }

  .uagb-tabs__wrap .uagb-tabs__panel {
    margin: 0;
    list-style: none;
    padding: 0;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-center {
    justify-content: center;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-left {
    justify-content: flex-start;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-right {
    justify-content: flex-end;
  }

  .uagb-tabs__wrap .uagb-tab {
    list-style: none;
  }

  .uagb-tabs__wrap .uagb-tabs-list {
    width: 100%;
    text-decoration: none;
  }

  .uagb-tabs__wrap .uagb-tabs__body-wrap {
    position: relative;
    max-width: 100%;
    padding: 10px;
  }

  .uagb-tabs__wrap.uagb-tabs__hstyle4-desktop .uagb-tab,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tab,
  .uagb-tabs__wrap.uagb-tabs__stack4-mobile .uagb-tab {
    border-radius: 999px;
  }

  .uagb-tabs__wrap.uagb-tabs__hstyle5-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__panel {
    justify-content: space-between;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop {
    flex-direction: row;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__panel {
    flex-direction: column;
    min-width: 24%;
    max-width: 24%;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__body-wrap {
    max-width: 75%;
    flex-grow: 1;
  }

  .uagb-tabs__wrap .uagb-tabs__body-container {
    display: none;
  }

  .uagb-tabs__wrap .uagb-tabs__body-container.uagb-tabs-body__active {
    display: block;
  }

  .vp-uagb-tabs {
    flex-direction: column;
    gap: 1.5rem;
  }

  .vp-uagb-tabs__title-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .vp-uagb-tabs__surface {
    border: 1px solid rgba(15, 23, 42, 0.1);
    padding: 0.5rem;
  }

  .vp-uagb-tabs__button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.75rem 1rem;
    text-align: left;
    border: 1px solid transparent;
    transition:
      opacity 0.2s ease,
      transform 0.2s ease,
      background-color 0.2s ease,
      color 0.2s ease;
  }

  .vp-uagb-tabs__body-wrap {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .vp-uagb-tabs__panel-surface {
    border: 1px solid rgba(15, 23, 42, 0.1);
    background: rgba(255, 255, 255, 0.78);
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
  }

  .vp-uagb-tabs__panel-stack {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .vp-uagb-tabs__panel-media-grid {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .vp-uagb-tabs__media-image {
    display: block;
    width: 100%;
    height: auto;
    object-fit: cover;
  }

  @media (min-width: 1024px) {
    .vp-uagb-tabs__panel-media-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      align-items: center;
    }
  }

  .uagb-slider-container {
    position: relative;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    transition: box-shadow 0.2s ease;
  }

  .uagb-swiper {
    position: relative;
    overflow: hidden;
  }

  .uagb-slider-container .swiper-wrapper {
    align-items: stretch;
  }

  .uagb-slider-container .swiper-notification {
    left: 0;
    top: 0;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    z-index: -1000;
  }

  .uagb-slider-container .swiper-button-next.swiper-button-disabled,
  .uagb-slider-container .swiper-button-prev.swiper-button-disabled {
    pointer-events: all;
  }

  .uagb-slider-container .swiper-button-prev,
  .uagb-slider-container .swiper-button-next {
    border-style: none;
    background: rgba(239, 239, 239, 0.9);
    color: #111111 !important;
    min-width: 2.75rem;
    min-height: 2.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
  }

  .uagb-slider-container .swiper-button-prev:empty::before {
    content: '\2039';
    font-size: 1.5rem;
    line-height: 1;
  }

  .uagb-slider-container .swiper-button-next:empty::before {
    content: '\203A';
    font-size: 1.5rem;
    line-height: 1;
  }

  .uagb-slider-container .swiper-pagination.swiper-pagination-bullets {
    max-width: 100%;
  }

  .uagb-slider-container .swiper-pagination-bullet {
    display: inline-flex;
  }

  .vp-uagb-carousel__viewport--draggable {
    user-select: none;
    cursor: grab;
  }

  .vp-uagb-carousel__viewport--draggable:active {
    cursor: grabbing;
  }

  .vp-uagb-carousel__track--stacked {
    position: relative;
    height: 100%;
  }

  .vp-uagb-carousel__track--slide {
    display: flex;
    height: 100%;
    transition-timing-function: ease-out;
  }

  .vp-uagb-carousel__slide {
    position: relative;
  }

  .vp-uagb-carousel__slide--stacked {
    position: absolute;
    inset: 0;
  }

  .vp-uagb-carousel__image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .vp-uagb-carousel__overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.72) 0%,
      rgba(0, 0, 0, 0.42) 48%,
      rgba(0, 0, 0, 0.1) 100%
    );
  }

  .vp-uagb-carousel__content {
    position: relative;
    z-index: 10;
    display: flex;
    height: 100%;
    flex-direction: column;
  }

  .vp-uagb-carousel__content--media {
    justify-content: flex-end;
    padding: 1.5rem;
  }

  .vp-uagb-carousel__content--plain {
    align-items: center;
    justify-content: center;
    padding: 0.75rem 1.5rem;
  }

  .vp-uagb-carousel__surface {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 1rem;
  }

  .vp-uagb-carousel__surface--media {
    background: rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(2px);
  }

  .vp-uagb-carousel__nav {
    pointer-events: none;
    position: absolute;
    inset-inline: 0;
    top: 50%;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transform: translateY(-50%);
    padding-inline: 0.75rem;
  }

  .vp-uagb-carousel__arrow {
    pointer-events: auto;
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }

  .vp-uagb-carousel__pagination {
    position: absolute;
    inset-inline: 0;
    bottom: 1.25rem;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .vp-uagb-carousel__bullet {
    transition:
      opacity 0.2s ease,
      transform 0.2s ease,
      width 0.2s ease;
  }

  @media (min-width: 640px) {
    .vp-uagb-carousel__content--media {
      padding: 2.5rem;
    }

    .vp-uagb-carousel__content--plain {
      padding: 1rem 2.5rem;
    }

    .vp-uagb-carousel__nav {
      padding-inline: 1.25rem;
    }
  }

  .wp-block-uagb-faq.uagb-faq__wrap {
    width: 100%;
  }

  .wp-block-uagb-faq .uagb-faq-child__outer-wrap {
    width: 100%;
  }

  .wp-block-uagb-faq .uagb-faq-item {
    overflow: hidden;
  }

  .wp-block-uagb-faq .uagb-faq-questions-button {
    cursor: pointer;
  }

  .wp-block-uagb-faq .uagb-faq-content {
    margin-bottom: 0;
  }

  .wp-block-uagb-faq .uagb-faq-content p {
    margin: auto;
  }

  .wp-block-uagb-faq .uagb-faq-icon-wrap {
    flex: 0 0 auto;
  }

  .vp-uagb-faq {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .vp-uagb-faq__item {
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 24px;
    padding: 0.25rem;
  }

  .vp-uagb-faq__question {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.25rem;
    text-align: left;
    border: 0;
    background: transparent;
  }

  .vp-uagb-faq__icon {
    display: inline-flex;
    width: 2.5rem;
    height: 2.5rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    transition: transform 0.2s ease;
  }

  .vp-uagb-faq__content {
    border-top: 1px solid rgba(15, 23, 42, 0.1);
    padding: 0.25rem 1.25rem 1.25rem;
  }

  .uagb-faq-layout-grid.uagb-faq-equal-height.uagb-faq__wrap
    .uagb-faq-child__outer-wrap,
  .uagb-faq-layout-grid.uagb-faq-equal-height.uagb-faq__wrap .uagb-faq-item {
    height: 100%;
  }
}
`;
