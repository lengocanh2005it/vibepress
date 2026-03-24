import { Module } from '@nestjs/common';
import { DeployAgentService } from './deploy-agent.service.js';

@Module({
  providers: [DeployAgentService],
  exports: [DeployAgentService],
})
export class DeployAgentModule {}
