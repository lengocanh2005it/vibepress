import type { WpDbCredentials } from './db-credentials.type.js';

export type ImportMode = 'sql' | 'direct_db' | 'github' | 'theme_zip';

export interface ImportResult {
  jobId: string;
  mode: ImportMode;
  status: 'pending';
  // Mode A
  sqlFilePath?: string;
  // Mode B
  dbCredentials?: WpDbCredentials;
  // Mode D / theme zip
  themeDir?: string;
  repoUrl?: string;
}
