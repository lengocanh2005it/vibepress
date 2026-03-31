import envConfig from '@/config/env.config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GroqModule } from './common/providers/groq/groq.module';
import { GeminiModule } from './common/providers/gemini/gemini.module';
import { CerebrasModule } from './common/providers/cerebras/cerebras.module.js';
import { MistralModule } from './common/providers/mistral/mistral.module.js';
import { AnthropicModule } from './common/providers/anthropic/anthropic.module.js';
import { OpenAIModule } from './common/providers/openai/openai.module.js';
import { OllamaModule } from './common/providers/ollama/ollama.module.js';
import { ImportModule } from './modules/import/import.module.js';
import { ThemeModule } from './modules/theme/theme.module.js';
import { SqlModule } from './modules/sql/sql.module.js';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module.js';
import { LlmModule } from './common/llm/llm.module.js';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfig],
    }),
    HttpModule.register({
      global: true,
      maxRedirects: 3,
      timeout: 10000,
    }),
    GroqModule,
    GeminiModule,
    CerebrasModule,
    MistralModule,
    AnthropicModule,
    OpenAIModule,
    OllamaModule,
    LlmModule,
    ImportModule,
    ThemeModule,
    SqlModule,
    OrchestratorModule,
  ],
})
export class AppModule {}
