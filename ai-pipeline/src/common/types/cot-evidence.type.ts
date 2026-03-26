export interface CotEvidence<T = any> {
  ac_id: string;
  ac_name: string;
  job_id: string;
  timestamp: string;
  reasoning: string[];
  evidence: T;
  passed: boolean;
}
