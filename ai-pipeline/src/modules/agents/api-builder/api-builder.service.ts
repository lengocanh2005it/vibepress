import { Injectable, Logger } from '@nestjs/common';
import { cp, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { DbContentResult } from '../db-content/db-content.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { buildCptRoutesPrompt } from './prompts/api.prompt.js';

const TEMPLATE_DIR = resolve('templates/express-server');

export interface ApiBuilderResult {
  outDir: string;
  files: { name: string; filePath: string; code: string }[];
}

@Injectable()
export class ApiBuilderService {
  private readonly logger = new Logger(ApiBuilderService.name);

  constructor(private readonly llm: LlmFactoryService) {}

  async build(input: {
    jobId?: string;
    dbName: string;
    content: Pick<
      DbContentResult,
      'siteInfo' | 'pages' | 'posts' | 'menus' | 'taxonomies' | 'capabilities' | 'customPostTypes' | 'commerce' | 'detectedPlugins'
    >;
  }): Promise<ApiBuilderResult> {
    const { jobId = 'unknown', content } = input;
    const outDir = join('./temp/generated', jobId, 'server');

    this.logger.log(`Copying Express server template for job: ${jobId}`);
    await cp(TEMPLATE_DIR, outDir, { recursive: true });

    const templateFile = join(outDir, 'index.ts');

    const PLUGIN_ROUTE_SLUGS = ['acf', 'yoast', 'contact-form-7'];
    const pluginsNeedingRoutes = content.detectedPlugins.filter((p) =>
      PLUGIN_ROUTE_SLUGS.includes(p.slug),
    );

    // No custom post types AND no plugins that need extra routes → template is sufficient
    if (content.customPostTypes.length === 0 && pluginsNeedingRoutes.length === 0) {
      this.logger.log(`No custom post types or plugin routes needed — using template as-is`);
      const code = await readFile(templateFile, 'utf-8');
      return { outDir, files: [{ name: 'index.ts', filePath: templateFile, code }] };
    }

    if (content.customPostTypes.length > 0) {
      this.logger.log(
        `Detected ${content.customPostTypes.length} custom post type(s): ` +
          content.customPostTypes.map((c) => `${c.postType}(${c.count})`).join(', '),
      );
    }
    if (pluginsNeedingRoutes.length > 0) {
      this.logger.log(
        `Plugins needing extra routes: ${pluginsNeedingRoutes.map((p) => p.slug).join(', ')}`,
      );
    }

    // Ask LLM to generate ONLY the extra routes for custom post types
    const prompt = buildCptRoutesPrompt(content as DbContentResult);
    const { text } = await this.llm.chat({
      model: this.llm.getModel(),
      userPrompt: prompt,
      maxTokens: 4096,
      temperature: 0,
    });

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

    await writeFile(templateFile, injected, 'utf-8');
    const injectSummary = [
      content.customPostTypes.length > 0 ? `${content.customPostTypes.length} CPT(s)` : null,
      pluginsNeedingRoutes.length > 0 ? `${pluginsNeedingRoutes.map((p) => p.slug).join(', ')} routes` : null,
    ].filter(Boolean).join(', ');
    this.logger.log(`Injected [${injectSummary}] into ${templateFile}`);

    return { outDir, files: [{ name: 'index.ts', filePath: templateFile, code: injected }] };
  }
}
