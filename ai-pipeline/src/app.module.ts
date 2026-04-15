import envConfig from '@/config/env.config';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpenAIModule } from './common/providers/openai/openai.module.js';
import { CustomModule } from './common/providers/custom/custom.module.js';
import { ThemeModule } from './modules/theme/theme.module.js';
import { SqlModule } from './modules/sql/sql.module.js';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module.js';
import { LlmModule } from './common/llm/llm.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfig],
    }),
    HttpModule.register({
      global: true,
      maxRedirects: 3,
    }),
    OpenAIModule,
    CustomModule,
    LlmModule,
    ThemeModule,
    SqlModule,
    OrchestratorModule,
  ],
})
export class AppModule {}
