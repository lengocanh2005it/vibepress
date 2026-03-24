import { Module } from '@nestjs/common';
import { RepoAnalyzerService } from './repo-analyzer.service.js';

@Module({
  providers: [RepoAnalyzerService],
  exports: [RepoAnalyzerService],
})
export class RepoAnalyzerModule {}
