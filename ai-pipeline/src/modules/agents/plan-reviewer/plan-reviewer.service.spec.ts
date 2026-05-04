import { PlanReviewerService } from './plan-reviewer.service.js';
import type { PlanResult } from '../planner/planner.service.js';

describe('PlanReviewerService', () => {
  const service = new PlanReviewerService();

  it('normalizes custom non-detail templates away from slug routes and detail data needs', () => {
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
    expect(reviewed.route).toBe('/template-about');
    expect(reviewed.isDetail).toBe(false);
    expect(reviewed.dataNeeds).toEqual([]);
  });
});
