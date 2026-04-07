import { Injectable, Logger } from '@nestjs/common';
import { cp, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { DbContentResult } from '../db-content/db-content.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { buildCptRoutesPrompt } from './prompts/api.prompt.js';

const TEMPLATE_DIR = resolve('templates/express-server');

/** LLMs sometimes emit `app.get(getPrefix() + '...')` — that calls getPrefix at load time without conn and crashes. */
function assertInjectedRoutesDoNotMisuseGetPrefix(injectedCode: string): void {
  const routeMisuse = /app\.(?:get|post|put|delete|patch)\(\s*getPrefix\s*\(/;
  const concatMisuse = /\bgetPrefix\s*\(\s*\)\s*\+/;
  if (routeMisuse.test(injectedCode) || concatMisuse.test(injectedCode)) {
    throw new Error(
      'Generated API routes misuse getPrefix(): use a string literal for the route path ' +
        '(e.g. app.get("/api/...")) and call `const prefix = await getPrefix(conn)` inside the handler after getConn().',
    );
  }
}

export interface ApiBuilderResult {
  outDir: string;
  files: { name: string; filePath: string; code: string }[];
}

@Injectable()
export class ApiBuilderService {
  private readonly logger = new Logger(ApiBuilderService.name);
  private readonly tokenTracker = new TokenTracker();

  constructor(private readonly llm: LlmFactoryService) {}

  async build(input: {
    jobId?: string;
    dbName: string;
    logPath?: string;
    content: Pick<
      DbContentResult,
      | 'siteInfo'
      | 'pages'
      | 'posts'
      | 'menus'
      | 'taxonomies'
      | 'capabilities'
      | 'customPostTypes'
      | 'commerce'
      | 'detectedPlugins'
    >;
  }): Promise<ApiBuilderResult> {
    const { jobId = 'unknown', content, logPath } = input;
    const outDir = join('./temp/generated', jobId, 'server');

    this.logger.log(`Copying Express server template for job: ${jobId}`);
    await cp(TEMPLATE_DIR, outDir, { recursive: true });

    const templateFile = join(outDir, 'index.ts');

    // Only generate AI routes for popular plugins that need custom API endpoints
    const PLUGINS_NEEDING_AI_ROUTES = new Set([
      'woocommerce', // e-commerce functionality
      'contact-form-7', // form submissions
      'wpforms', // form submissions
      'elementor', // dynamic content
      'divi-builder', // dynamic content
      'acf', // advanced custom fields
      'polylang', // multi-language
      'wpml', // multi-language
    ]);
    /** Skip AI routes for these plugins — rely on template or manual implementation */
    const PLUGIN_SLUGS_SKIP_AI_ROUTES = new Set(['vibepress-db-info']);
    const pluginsNeedingRoutes = content.detectedPlugins.filter(
      (p) =>
        PLUGINS_NEEDING_AI_ROUTES.has(p.slug) &&
        !PLUGIN_SLUGS_SKIP_AI_ROUTES.has(p.slug) &&
        p.confidence !== 'low',
    );

    // No custom post types AND no popular plugins detected → template is sufficient
    if (
      content.customPostTypes.length === 0 &&
      pluginsNeedingRoutes.length === 0
    ) {
      this.logger.log(
        `No custom post types or popular plugins needing routes — using template as-is`,
      );
      const code = await readFile(templateFile, 'utf-8');
      return {
        outDir,
        files: [{ name: 'index.ts', filePath: templateFile, code }],
      };
    }

    if (content.customPostTypes.length > 0) {
      this.logger.log(
        `Detected ${content.customPostTypes.length} custom post type(s): ` +
          content.customPostTypes
            .map((c) => `${c.postType}(${c.count})`)
            .join(', '),
      );
    }
    if (pluginsNeedingRoutes.length > 0) {
      this.logger.log(
        `Popular plugins needing AI-generated routes: ${pluginsNeedingRoutes.map((p) => p.slug).join(', ')}`,
      );
    }

    // Ask LLM to generate ONLY the extra routes for custom post types
    const prompt = buildCptRoutesPrompt(content as DbContentResult);
    const { text, inputTokens, outputTokens } = await this.llm.chat({
      model: this.llm.getModel(),
      userPrompt: prompt,
      maxTokens: 4096,
      temperature: 0,
    });
    const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
    if (tokenLogPath) {
      await this.tokenTracker.init(tokenLogPath);
      await this.tokenTracker.track(
        this.llm.getModel(),
        inputTokens,
        outputTokens,
        'backend-gen:routes',
      );
    }

    const extraRoutes = text
      .replace(/^```[\w]*\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();

    // Inject the generated routes into the template just before app.listen(...)
    const templateCode = await readFile(templateFile, 'utf-8');
    const injected = templateCode.replace(
      /^(app\.listen\()/m,
      `${extraRoutes}\n\n$1`,
    );

    assertInjectedRoutesDoNotMisuseGetPrefix(injected);

    await writeFile(templateFile, injected, 'utf-8');
    const injectSummary = [
      content.customPostTypes.length > 0
        ? `${content.customPostTypes.length} CPT(s)`
        : null,
      pluginsNeedingRoutes.length > 0
        ? `${pluginsNeedingRoutes.map((p) => p.slug).join(', ')} plugin routes`
        : null,
    ]
      .filter(Boolean)
      .join(', ');
    this.logger.log(`Injected [${injectSummary}] into ${templateFile}`);

    return {
      outDir,
      files: [{ name: 'index.ts', filePath: templateFile, code: injected }],
    };
  }

  async fixApi(input: {
    result: ApiBuilderResult;
    feedback: string;
    modelName?: string;
    logPath?: string;
  }): Promise<ApiBuilderResult> {
    const { result, feedback, modelName } = input;
    const resolvedModel = modelName ?? this.llm.getModel();
    const tokenLogPath = TokenTracker.getTokenLogPath(input.logPath);

    this.logger.log(`[api-fixer] Auto-fixing backend based on review feedback`);

    // For now, we only have one backend file: index.ts
    const indexFile = result.files.find((f) => f.name === 'index.ts');
    if (!indexFile) return result;

    const { text, inputTokens, outputTokens } = await this.llm.chat({
      model: resolvedModel,
      systemPrompt:
        'You are an Express/TypeScript expert. Fix the reported issue in the server code. Return ONLY the complete corrected code, no explanation.',
      userPrompt: `The following Express server code has a review failure: ${feedback}\n\nFix it and return the complete corrected code:\n\`\`\`ts\n${indexFile.code}\n\`\`\``,
      maxTokens: 4096,
    });
    if (tokenLogPath) {
      await this.tokenTracker.init(tokenLogPath);
      await this.tokenTracker.track(
        resolvedModel,
        inputTokens,
        outputTokens,
        'backend-fix:1',
      );
    }

    const fixedCode = text
      .replace(/^```[\w]*\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();

    assertInjectedRoutesDoNotMisuseGetPrefix(fixedCode);

    await writeFile(indexFile.filePath, fixedCode, 'utf-8');
    indexFile.code = fixedCode;

    return result;
  }
}
