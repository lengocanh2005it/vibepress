import { PlanReviewerService } from './plan-reviewer.service.js';
import type { PlanResult } from '../planner/planner.service.js';

describe('PlanReviewerService', () => {
  const service = new PlanReviewerService();

  it('keeps named custom page templates on their template-specific detail route contract', () => {
    const plan: PlanResult = [
      {
        templateName: 'template-about',
        componentName: 'TemplateAbout',
        type: 'page',
        route: '/template-about/:slug',
        dataNeeds: ['page-detail', 'post-detail'],
        isDetail: true,
        description: 'About template',
      },
    ];

    const review = service.review(plan, ['template-about']);
    const reviewed = review.plan[0];

    expect(review.errors).toEqual([]);
    expect(reviewed.route).toBe('/template-about/:slug');
    expect(reviewed.isDetail).toBe(true);
    expect(reviewed.dataNeeds).toEqual(['page-detail']);
  });

  it('normalizes colliding named page templates onto distinct template-specific detail routes', () => {
    const plan: PlanResult = [
      {
        templateName: 'template-about',
        componentName: 'TemplateAbout',
        type: 'page',
        route: '/page/:slug',
        dataNeeds: ['page-detail'],
        isDetail: true,
        description: 'About template',
      },
      {
        templateName: 'template-contact',
        componentName: 'TemplateContact',
        type: 'page',
        route: '/page/:slug',
        dataNeeds: ['page-detail'],
        isDetail: true,
        description: 'Contact template',
      },
      {
        templateName: 'template-services',
        componentName: 'TemplateServices',
        type: 'page',
        route: '/page/:slug',
        dataNeeds: ['page-detail'],
        isDetail: true,
        description: 'Services template',
      },
    ];

    const review = service.review(plan, [
      'template-about',
      'template-contact',
      'template-services',
    ]);

    expect(review.errors).toEqual([]);
    expect(review.plan.map((item) => item.route)).toEqual([
      '/template-about/:slug',
      '/template-contact/:slug',
      '/template-services/:slug',
    ]);
    expect(review.warningCodes).not.toContain('duplicate_route_normalized');
  });

  it('does not emit a routine warning for normal front-page plus index home hierarchy', () => {
    const plan: PlanResult = [
      {
        templateName: 'front-page',
        componentName: 'FrontPage',
        type: 'page',
        route: '/',
        dataNeeds: [],
        isDetail: false,
        description: 'Front page template',
        homeMode: 'posts-index',
      },
      {
        templateName: 'index',
        componentName: 'Index',
        type: 'page',
        route: '/blog',
        dataNeeds: ['posts'],
        isDetail: false,
        description: 'Posts index template',
        homeMode: 'posts-index',
      },
    ];

    const review = service.review(plan, ['front-page', 'index']);

    expect(review.warningCodes).not.toContain(
      'multiple_home_like_templates_detected',
    );
  });

  it('does not force footer-links for CTA footers without footer menu columns', () => {
    const plan: PlanResult = [
      {
        templateName: 'front-page',
        componentName: 'FrontPage',
        type: 'page',
        route: '/',
        dataNeeds: [],
        isDetail: false,
        description: 'Front page template',
      },
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: [],
        isDetail: false,
        description: 'CTA footer template',
        visualPlan: {
          componentName: 'Footer',
          dataNeeds: [],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [
            {
              type: 'footer',
              menuColumns: [],
              showSiteLogo: false,
              showSiteTitle: false,
              showTagline: false,
            },
          ],
        },
      },
    ];

    const review = service.review(plan, ['front-page', 'footer']);
    const footer = review.plan.find((item) => item.componentName === 'Footer');

    expect(review.errors).toEqual([]);
    expect(footer?.dataNeeds).toEqual([]);
    expect(footer?.visualPlan?.dataNeeds).toEqual([]);
  });

  it('keeps footer-links only when footer visual plan has menu columns', () => {
    const plan: PlanResult = [
      {
        templateName: 'front-page',
        componentName: 'FrontPage',
        type: 'page',
        route: '/',
        dataNeeds: [],
        isDetail: false,
        description: 'Front page template',
      },
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: [],
        isDetail: false,
        description: 'Menu footer template',
        visualPlan: {
          componentName: 'Footer',
          dataNeeds: [],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [
            {
              type: 'footer',
              menuColumns: [{ title: 'Company', menuSlug: 'footer' }],
              showSiteTitle: true,
            },
          ],
        },
      },
    ];

    const review = service.review(plan, ['front-page', 'footer']);
    const footer = review.plan.find((item) => item.componentName === 'Footer');

    expect(review.errors).toEqual([]);
    expect(footer?.dataNeeds).toEqual(['site-info', 'footer-links']);
    expect(footer?.visualPlan?.dataNeeds).toEqual(['siteInfo', 'footerLinks']);
  });

  it('allows multiple exact page bindings for the same named template', () => {
    const plan: PlanResult = [
      {
        templateName: 'template-about',
        componentName: 'PageSamplePage',
        type: 'page',
        route: '/page/sample-page',
        dataNeeds: ['page-detail'],
        isDetail: true,
        fixedSlug: 'sample-page',
        fixedPageId: 2,
        description: 'About Us binding',
      },
      {
        templateName: 'template-about',
        componentName: 'PageSeniorSwe',
        type: 'page',
        route: '/page/senior-swe',
        dataNeeds: ['page-detail'],
        isDetail: true,
        fixedSlug: 'senior-swe',
        fixedPageId: 17,
        description: 'Our Story binding',
      },
      {
        templateName: 'template-about',
        componentName: 'PageTitle1',
        type: 'page',
        route: '/page/title1',
        dataNeeds: ['page-detail'],
        isDetail: true,
        fixedSlug: 'title1',
        fixedPageId: 15,
        description: 'Title1 binding',
      },
    ];

    const review = service.review(plan, ['template-about']);

    expect(review.errors).toEqual([]);
  });
});
