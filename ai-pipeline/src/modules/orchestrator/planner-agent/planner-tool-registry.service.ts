import { Injectable } from '@nestjs/common';
import { PlanReviewerService } from '../../agents/plan-reviewer/plan-reviewer.service.js';
import { PlannerService } from '../../agents/planner/planner.service.js';
import type {
  PlannerAgentInput,
  PlannerAgentState,
  PlannerToolDefinition,
} from './planner-agent.types.js';
import { summarizePlan } from './planner-agent.types.js';

@Injectable()
export class PlannerToolRegistryService {
  constructor(
    private readonly planner: PlannerService,
    private readonly planReviewer: PlanReviewerService,
  ) {}

  createTools(input: PlannerAgentInput): PlannerToolDefinition[] {
    return [
      {
        name: 'generate_plan',
        description:
          'Generate or regenerate the architecture plan without visual sections.',
        inputHint:
          '{"planReviewErrors":["optional review errors from previous attempt"]}',
        execute: async (state, toolInput) => {
          const feedback = Array.isArray(toolInput.planReviewErrors)
            ? toolInput.planReviewErrors
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean)
            : undefined;

          state.plan = await this.planner.plan(
            input.normalizedTheme,
            input.content,
            input.modelName,
            input.jobId,
            {
              includeVisualPlans: false,
              logPath: input.logPath,
              repoManifest: input.repoManifest,
              planReviewErrors: feedback?.length ? feedback : undefined,
            },
          );
          state.review = undefined;
          state.visualsAttached = false;

          return {
            summary: `Generated plan: ${summarizePlan(state.plan)}`,
          };
        },
      },
      {
        name: 'review_plan',
        description:
          'Run deterministic plan review on the current architecture plan.',
        inputHint: '{}',
        execute: async (state: PlannerAgentState) => {
          if (!state.plan?.length) {
            throw new Error('Cannot review plan before generate_plan');
          }
          state.review = this.planReviewer.review(
            state.plan,
            input.expectedTemplateNames,
            input.repoManifest,
          );

          return {
            summary: state.review.isValid
              ? `Plan review passed: ${summarizePlan(state.review.plan)}`
              : `Plan review failed with ${state.review.errors.length} error(s): ${state.review.errors.join('; ')}`,
          };
        },
      },
      {
        name: 'attach_visual_plans',
        description: 'Generate visual sections for the current reviewed plan.',
        inputHint: '{}',
        execute: async (state: PlannerAgentState) => {
          const basePlan = state.review?.plan ?? state.plan;
          if (!basePlan?.length) {
            throw new Error(
              'Cannot attach visual plans before a plan has been generated',
            );
          }
          state.plan = await this.planner.attachVisualPlans(
            input.normalizedTheme,
            input.content,
            basePlan,
            input.modelName,
            input.repoManifest,
          );
          state.review = undefined;
          state.visualsAttached = true;

          return {
            summary: `Attached visual plans: ${summarizePlan(state.plan)}`,
          };
        },
      },
      {
        name: 'review_visual_plan',
        description:
          'Run deterministic review after visual sections have been attached.',
        inputHint: '{}',
        execute: async (state: PlannerAgentState) => {
          if (!state.plan?.length || !state.visualsAttached) {
            throw new Error(
              'Cannot review visual plan before attach_visual_plans',
            );
          }
          state.review = this.planReviewer.review(
            state.plan,
            input.expectedTemplateNames,
            input.repoManifest,
          );

          return {
            summary: state.review.isValid
              ? `Visual plan review passed: ${summarizePlan(state.review.plan)}`
              : `Visual plan review failed with ${state.review.errors.length} error(s): ${state.review.errors.join('; ')}`,
          };
        },
      },
    ];
  }
}
