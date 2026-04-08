import type { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReplaySubject } from 'rxjs';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { AgentResult } from '@/common/types/pipeline.type.js';
import type { RunPipelineDto } from '../orchestrator.controller.js';
import type {
  RepoAnalyzeResult,
  RepoResolvedSourceSummary,
  RepoThemeManifest,
} from '../../agents/repo-analyzer/repo-analyzer.service.js';
import type {
  BlockParseResult,
  ThemeTokens,
} from '../../agents/block-parser/block-parser.service.js';
import type { PhpParseResult } from '../../agents/php-parser/php-parser.service.js';
import type { DbContentResult } from '../../agents/db-content/db-content.service.js';
import type { PlanReviewResult } from '../../agents/plan-reviewer/plan-reviewer.service.js';
import type {
  GeneratedComponent,
  ReactGenerateResult,
} from '../../agents/react-generator/react-generator.service.js';
import type { PreviewBuilderResult } from '../../agents/preview-builder/preview-builder.service.js';
import type { VisualReviewResult } from '../../agents/preview-builder/visual-route-review.service.js';
import type { SqlService } from '../../sql/sql.service.js';
import type { WpQueryService } from '../../sql/wp-query.service.js';
import type { ThemeDetectorService } from '../../theme/theme-detector.service.js';
import type { RepoAnalyzerService } from '../../agents/repo-analyzer/repo-analyzer.service.js';
import type { PhpParserService } from '../../agents/php-parser/php-parser.service.js';
import type { BlockParserService } from '../../agents/block-parser/block-parser.service.js';
import type { NormalizerService } from '../../agents/normalizer/normalizer.service.js';
import type { DbContentService } from '../../agents/db-content/db-content.service.js';
import type { PlannerService } from '../../agents/planner/planner.service.js';
import type { PlanReviewerService } from '../../agents/plan-reviewer/plan-reviewer.service.js';
import type { ReactGeneratorService } from '../../agents/react-generator/react-generator.service.js';
import type { GeneratedCodeReviewService } from '../../agents/react-generator/generated-code-review.service.js';
import type { ApiBuilderService } from '../../agents/api-builder/api-builder.service.js';
import type { GeneratedApiReviewService } from '../../agents/api-builder/generated-api-review.service.js';
import type { PreviewBuilderService } from '../../agents/preview-builder/preview-builder.service.js';
import type { VisualRouteReviewService } from '../../agents/preview-builder/visual-route-review.service.js';
import type { ValidatorService } from '../../agents/validator/validator.service.js';
import type { SourceResolverService } from '../../agents/source-resolver/source-resolver.service.js';
import type { CleanupService } from '../../agents/cleanup/cleanup.service.js';
import type { PlannerAgentRuntimeService } from '../planner-agent/planner-agent-runtime.service.js';

export type ThemeParseResult = PhpParseResult | BlockParseResult;
export type ThemeNormalizeResult = ThemeParseResult & { tokens?: ThemeTokens };

export interface PipelineResolvedModels {
  planning: string;
  genCode: string;
  reviewCode?: string;
  backendReview?: string;
  aiReviewMode: 'warn' | 'blocking';
  backendAiReviewMode: 'warn' | 'blocking';
  fixAgent?: string;
}

export interface PipelineStatusLike {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: Array<{ name: string; status: string; error?: string }>;
  result?: unknown;
  error?: string;
}

export interface PipelineExecutionContext {
  jobId: string;
  dto: RunPipelineDto;
  state: PipelineStatusLike;
  jobLogDir: string;
  logPath: string;
  pipelineStart: number;
  resolvedModels: PipelineResolvedModels;
  dbCreds: WpDbCredentials;
  themeGithubToken?: string;
  repoResult?: RepoAnalyzeResult;
  themeDir?: string;
  parsedTheme?: ThemeParseResult;
  normalizedTheme?: ThemeNormalizeResult;
  content?: DbContentResult;
  resolvedSource?: RepoResolvedSourceSummary;
  reviewResult?: PlanReviewResult;
  generationResult?: ReactGenerateResult;
  buildComponents?: GeneratedComponent[];
  preview?: PreviewBuilderResult;
  metrics?: unknown;
  visualRouteResults?: VisualReviewResult[];
  totalElapsed?: string;
}

export interface StepMeta {
  label: string;
  weight: number;
  activeMessage: string;
  doneMessage: string;
}

export interface CompletionEventPayload {
  previewUrl: string;
  metrics: unknown;
  totalElapsed: string;
}

export interface OrchestratorStageRuntime {
  logger: Logger;
  configService: ConfigService;
  sqlService: SqlService;
  wpQuery: WpQueryService;
  themeDetector: ThemeDetectorService;
  repoAnalyzer: RepoAnalyzerService;
  phpParser: PhpParserService;
  blockParser: BlockParserService;
  normalizer: NormalizerService;
  dbContent: DbContentService;
  planner: PlannerService;
  planReviewer: PlanReviewerService;
  reactGenerator: ReactGeneratorService;
  generatedCodeReview: GeneratedCodeReviewService;
  apiBuilder: ApiBuilderService;
  generatedApiReview: GeneratedApiReviewService;
  previewBuilder: PreviewBuilderService;
  visualRouteReview: VisualRouteReviewService;
  validator: ValidatorService;
  sourceResolver: SourceResolverService;
  cleanup: CleanupService;
  plannerAgentRuntime: PlannerAgentRuntimeService;
  runStep<T>(
    state: PipelineStatusLike,
    name: string,
    logPath: string,
    fn: () => Promise<T | AgentResult<T>>,
  ): Promise<T>;
  emitStepProgress(
    state: PipelineStatusLike,
    name: string,
    progressWithinStep: number,
    message: string,
    data?: any,
  ): void;
  logToFile(logPath: string, message: string): Promise<void>;
  cloneThemeRepo(
    repoUrl: string,
    token: string | undefined,
    jobId: string,
  ): Promise<string>;
  resolveThemeDir(
    repoRoot: string,
    dbConnectionString: string,
  ): Promise<string>;
  recordRepoAnalysis(
    jobLogDir: string,
    logPath: string,
    repoResult: RepoAnalyzeResult,
  ): Promise<void>;
  enrichThemeWithPluginTemplates(input: {
    theme: ThemeParseResult;
    themeDir: string;
    manifest: RepoThemeManifest;
    resolvedSource: RepoResolvedSourceSummary;
    logPath?: string;
  }): Promise<{ theme: ThemeParseResult }>;
  parseTsBuildErrors(
    errorOutput: string,
  ): Array<{ componentName: string; error: string }>;
  delayBetweenSteps(): Promise<void>;
  emitCompletion(
    state: PipelineStatusLike,
    payload: CompletionEventPayload,
  ): void;
  completeProgress(jobId: string): void;
  scheduleProgressCleanup(jobId: string): void;
  getStepMeta(name: string): StepMeta;
  getProgressStream(jobId: string): ReplaySubject<any> | undefined;
}
