import { Injectable } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CotEvidence } from '../../common/types/cot-evidence.type.js';

@Injectable()
export class CotEvidenceService {
  async write<T>(
    jobId: string,
    acKey: string,
    acName: string,
    evidence: T,
    reasoning: string[],
    passed: boolean,
  ): Promise<void> {
    const evidenceDir = join('./temp/logs', jobId, 'cot');
    await mkdir(evidenceDir, { recursive: true });

    const payload: CotEvidence<T> = {
      ac_id: acKey.toUpperCase(),
      ac_name: acName,
      job_id: jobId,
      timestamp: new Date().toISOString(),
      reasoning,
      evidence,
      passed,
    };

    await writeFile(
      join(evidenceDir, `${acKey.toLowerCase()}-evidence.json`),
      JSON.stringify(payload, null, 2),
    );
  }
}
