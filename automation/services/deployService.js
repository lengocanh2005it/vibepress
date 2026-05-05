const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const fse = require('fs-extra');
const axios = require('axios');
const { simpleGit } = require('simple-git');
const { NodeSSH } = require('node-ssh');
const {
  GITHUB_TOKEN,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  TEMP_ROOT,
  VPS_HOST,
  VPS_USER,
  VPS_SSH_KEY_PATH,
  VPS_SSH_PASSWORD,
  VPS_FRONTEND_DIR,
  VPS_BACKEND_DIR,
  VPS_DOMAIN,
  VPS_BACKEND_BASE_PORT,
} = require('../config/constants');

const execAsync = promisify(exec);

const AI_PIPELINE_GENERATED_DIR = path.resolve(
  __dirname,
  '../../ai-pipeline/temp/generated',
);

// ── VPS helpers ───────────────────────────────────────────────────────────────

// Gán port cố định cho mỗi site dựa trên tên — deterministic, không cần state
function sitePort(siteDir) {
  let hash = 0;
  for (let i = 0; i < siteDir.length; i++) {
    hash = ((hash << 5) - hash + siteDir.charCodeAt(i)) | 0;
  }
  return VPS_BACKEND_BASE_PORT + (Math.abs(hash) % 1000);
}

async function connectSsh() {
  const ssh = new NodeSSH();
  const opts = { host: VPS_HOST, username: VPS_USER };
  if (VPS_SSH_KEY_PATH) {
    opts.privateKeyPath = VPS_SSH_KEY_PATH;
  } else if (VPS_SSH_PASSWORD) {
    opts.password = VPS_SSH_PASSWORD;
  } else {
    throw new Error('VPS: cần cấu hình VPS_SSH_KEY_PATH hoặc VPS_SSH_PASSWORD');
  }
  await ssh.connect(opts);
  return ssh;
}

async function deployBackendToVps({ workDir, siteDir, dbCreds }) {
  const port = sitePort(siteDir);
  const remoteDir = `${VPS_BACKEND_DIR}/${siteDir}`;
  const localServerDir = path.join(workDir, 'server');

  console.log(`[VPS-Backend] site=${siteDir} port=${port} remote=${remoteDir}`);
  const ssh = await connectSsh();
  try {
    // mkdir
    const mkdirRes = await ssh.execCommand(`mkdir -p ${remoteDir}`);
    if (mkdirRes.code !== 0) {
      throw new Error(`[VPS-Backend] mkdir -p ${remoteDir} thất bại (code=${mkdirRes.code}): ${mkdirRes.stderr}`);
    }

    // Upload server/ — bỏ qua node_modules
    await ssh.putDirectory(localServerDir, remoteDir, {
      recursive: true,
      concurrency: 5,
      validate: (itemPath) =>
        !itemPath.includes('node_modules') && !itemPath.includes('.git'),
    });
    console.log(`[VPS-Backend] Files uploaded`);

    // Ghi .env qua SFTP
    const envContent = [
      `API_PORT=${port}`,
      `DB_HOST=${dbCreds.host ?? 'localhost'}`,
      `DB_PORT=${dbCreds.port ?? 3306}`,
      `DB_USER=${dbCreds.user ?? 'root'}`,
      `DB_PASSWORD=${dbCreds.password ?? ''}`,
      `DB_NAME=${dbCreds.dbName ?? 'wordpress'}`,
      `NODE_ENV=production`,
    ].join('\n');
    const tmpEnv = path.join(os.tmpdir(), `vps-env-${siteDir}-${Date.now()}`);
    await fse.writeFile(tmpEnv, envContent);
    try {
      await ssh.putFile(tmpEnv, `${remoteDir}/.env`);
    } catch (err) {
      throw new Error(`[VPS-Backend] Upload .env thất bại: ${err.message}`);
    } finally {
      await fse.remove(tmpEnv);
    }
    console.log(`[VPS-Backend] .env written`);

    // npm install
    const install = await ssh.execCommand(`cd ${remoteDir} && npm install --production`);
    if (install.stderr) console.warn(`[VPS-Backend] npm install stderr: ${install.stderr.slice(0, 400)}`);
    if (install.code !== 0) throw new Error(`[VPS-Backend] npm install thất bại (code=${install.code}): ${install.stderr.slice(0, 400)}`);
    console.log(`[VPS-Backend] npm install done`);

    // PM2 start/restart
    await ssh.execCommand(`pm2 delete "${siteDir}" 2>/dev/null || true`);
    const pm2 = await ssh.execCommand(
      `cd ${remoteDir} && API_PORT=${port} pm2 start npm --name "${siteDir}" -- start && pm2 save`,
    );
    if (pm2.code !== 0) throw new Error(`[VPS-Backend] PM2 thất bại (code=${pm2.code}): ${pm2.stderr}`);
    console.log(`[VPS-Backend] PM2 started — port ${port}`);

    // Allow Docker bridge network (172.16.0.0/12) to reach the backend port.
    // UFW's INPUT chain blocks container→host traffic by default; Docker does not add UFW exceptions automatically.
    await ssh.execCommand(
      `sudo ufw allow from 172.16.0.0/12 to any port ${port} proto tcp comment 'vibepress-${siteDir}' 2>/dev/null; true`,
    );
    console.log(`[VPS-Backend] UFW rule added for port ${port}`);

    // Verify the process came online
    await new Promise((r) => setTimeout(r, 3000));
    const pmStatus = await ssh.execCommand(`pm2 show "${siteDir}" 2>&1 | grep -E 'status|restart'`);
    console.log(`[VPS-Backend] PM2 status: ${pmStatus.stdout.trim() || pmStatus.stderr.trim()}`);
  } finally {
    ssh.dispose();
  }

  return { backendPort: port };
}

async function deployFrontendToVps({ workDir, siteDir, backendPort }) {
  const remoteDir = `${VPS_FRONTEND_DIR}/${siteDir}`;
  const frontendDir = path.join(workDir, 'frontend');
  const distDir = path.join(frontendDir, 'dist');
  const cleanDomain = VPS_DOMAIN?.replace(/^https?:\/\//i, '').replace(/\/+$/, '') || null;
  const domain = cleanDomain ? `${siteDir}.${cleanDomain}` : null;

  console.log(`[VPS-Frontend] Building site=${siteDir}...`);
  const hasNodeModules = await fse.pathExists(path.join(frontendDir, 'node_modules'));
  if (!hasNodeModules) {
    await execAsync('npm install', {
      cwd: frontendDir,
      env: { ...process.env, VITE_BASE: '/', VITE_API_BASE: '/api' },
    });
  }
  await execAsync('npm run build', {
    cwd: frontendDir,
    env: { ...process.env, VITE_BASE: '/', VITE_API_BASE: '/api' },
  });
  console.log(`[VPS-Frontend] Build done`);

  const ssh = await connectSsh();
  try {
    await ssh.execCommand(`mkdir -p ${remoteDir}`);

    // Upload dist/
    await ssh.putDirectory(distDir, remoteDir, { recursive: true, concurrency: 5 });
    console.log(`[VPS-Frontend] dist/ uploaded`);

    // Viết Nginx config qua SFTP rồi mv vào /var/nginx-sites/ (mounted vào container)
    const serverName = domain ?? '_';
    const nginxConf = [
      'server {',
      '    listen 80;',
      `    server_name ${serverName};`,
      `    root ${remoteDir};`,
      '    index index.html;',
      '    location / {',
      '        try_files $uri $uri/ /index.html;',
      '    }',
      '    location /api/ {',
      `        proxy_pass http://host.docker.internal:${backendPort};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '    }',
      '}',
    ].join('\n');

    const tmpNginx = path.join(os.tmpdir(), `nginx-${siteDir}-${Date.now()}.conf`);
    await fse.writeFile(tmpNginx, nginxConf);
    await ssh.putFile(tmpNginx, `/tmp/${siteDir}.conf`);
    await fse.remove(tmpNginx);

    const nginx = await ssh.execCommand(
      `sudo mkdir -p /var/nginx-sites` +
      ` && sudo find /var/nginx-sites -name 'react-migration-*.conf' -delete` +
      ` && sudo mv /tmp/${siteDir}.conf /var/nginx-sites/${siteDir}.conf` +
      ` && docker exec vibepress_frontend nginx -s reload`,
    );
    if (nginx.code !== 0) throw new Error(`Nginx config failed: ${nginx.stderr}`);
    console.log(`[VPS-Frontend] Nginx reloaded`);
  } finally {
    ssh.dispose();
  }

  const frontendUrl = domain ? `http://${domain}` : `http://${VPS_HOST}`;
  console.log(`[VPS-Frontend] Live: ${frontendUrl}`);
  return { frontendUrl };
}

// ── GitHub ────────────────────────────────────────────────────────────────────

let _cachedGithubOwner = null;
async function getGithubOwner(headers) {
  if (_cachedGithubOwner) return _cachedGithubOwner;
  const res = await axios.get('https://api.github.com/user', { headers });
  _cachedGithubOwner = res.data.login;
  console.log(`[GitHub] Authenticated as: ${_cachedGithubOwner}`);
  return _cachedGithubOwner;
}

async function createGithubRepo(repoName) {
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  };

  console.log(`[GitHub] Creating repo: ${repoName}`);
  try {
    const res = await axios.post(
      'https://api.github.com/user/repos',
      { name: repoName, private: true, auto_init: false },
      { headers },
    );
    console.log(`[GitHub] Repo created: ${res.data.html_url}`);
    return { name: res.data.name, htmlUrl: res.data.html_url, cloneUrl: res.data.clone_url };
  } catch (err) {
    // 422 = repo đã tồn tại → lấy thông tin repo hiện có
    if (err.response?.status === 422) {
      console.log(`[GitHub] Repo "${repoName}" already exists — fetching existing repo`);
      try {
        const owner = await getGithubOwner(headers);
        const existing = await axios.get(
          `https://api.github.com/repos/${owner}/${repoName}`,
          { headers },
        );
        console.log(`[GitHub] Using existing repo: ${existing.data.html_url}`);
        return { name: existing.data.name, htmlUrl: existing.data.html_url, cloneUrl: existing.data.clone_url };
      } catch (fetchErr) {
        throw new Error(`GitHub: failed to fetch existing repo "${repoName}" (${fetchErr.response?.status ?? fetchErr.message})`);
      }
    }
    throw new Error(`GitHub: create repo failed (${err.response?.status ?? err.message}): ${JSON.stringify(err.response?.data)}`);
  }
}

async function initAndPush({ workDir, repoCloneUrl, branch, message }) {
  console.log(`[Git] Init & push to branch "${branch}" — ${message}`);
  const authedUrl = repoCloneUrl.replace(
    'https://',
    `https://x-access-token:${encodeURIComponent(GITHUB_TOKEN)}@`,
  );
  const gitignore = [
    'node_modules',
    '**/node_modules',
    '.env',
    '**/.env',
    '**/.env.*',
    'dist/',
    '.vite/',
    'draft/',
    'ui-source-map.json',
  ].join('\n');
  await fse.writeFile(path.join(workDir, '.gitignore'), gitignore);

  const git = simpleGit(workDir);
  await git.init();
  await git.addConfig('user.email', GIT_AUTHOR_EMAIL);
  await git.addConfig('user.name', GIT_AUTHOR_NAME);
  await git.checkoutLocalBranch(branch);
  await git.add('.');

  const status = await git.status();
  console.log(`[Git] Files staged: ${status.files.length}`);

  await git.commit(message);
  await git.addRemote('origin', authedUrl);
  await git.push('origin', branch, ['--set-upstream', '--force']);

  const log = await git.log({ maxCount: 1 });
  const sha = log.latest?.hash ?? '';
  console.log(`[Git] Pushed — commit: ${sha}`);
  return sha;
}


// ── Push to Git only ─────────────────────────────────────────────────────────

async function pushToGit({ jobId, repoName, branch = 'main' }) {
  console.log(`\n[PushToGit] ── Start jobId=${jobId} ──────────────────────`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');

  const generatedDir = path.join(AI_PIPELINE_GENERATED_DIR, jobId);
  console.log(`[PushToGit] Checking generated dir: ${generatedDir}`);
  if (!(await fse.pathExists(generatedDir))) {
    throw new Error(`Generated directory not found for jobId: ${jobId}`);
  }

  const finalRepoName = repoName || `react-migration-${jobId.slice(0, 8)}`;
  console.log(`[PushToGit] Repo name: ${finalRepoName}`);

  // 1. Tạo GitHub repo
  const repo = await createGithubRepo(finalRepoName);

  // 2. Push lên GitHub
  const commitSha = await initAndPush({
    workDir: generatedDir,
    repoCloneUrl: repo.cloneUrl,
    branch,
    message: `feat: initial React migration [jobId=${jobId}]`,
  });

  console.log(`\n[PushToGit] ── Done — GitHub: ${repo.htmlUrl} ──────────`);

  return {
    jobId,
    repoName: finalRepoName,
    githubUrl: repo.htmlUrl,
    commitSha,
  };
}

// ── Main flow (VPS) ───────────────────────────────────────────────────────────

async function deployFullStack({ jobId, repoName, branch = 'main', dbCreds = {} }) {
  console.log(`\n[Deploy] ── Start jobId=${jobId} ──────────────────────────`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  if (!VPS_HOST) throw new Error('VPS_HOST is not configured');

  const generatedDir = path.join(AI_PIPELINE_GENERATED_DIR, jobId);
  console.log(`[Deploy] Checking generated dir: ${generatedDir}`);
  if (!(await fse.pathExists(generatedDir))) {
    throw new Error(`Generated directory not found for jobId: ${jobId}`);
  }

  const finalRepoName = repoName || `react-migration-${jobId.slice(0, 8)}`;
  console.log(`[Deploy] Repo name: ${finalRepoName}`);

  // Resolve DB host — PM2 chạy trên host OS, không resolve Docker-internal hostnames
  // MYSQL_PORT là host-mapped port (vd: 3307), khác với Docker-internal port (3306)
  const DOCKER_INTERNAL_HOSTS = ['localhost', '127.0.0.1', 'db', 'mysql'];
  const isLocalHost = !dbCreds.host || DOCKER_INTERNAL_HOSTS.includes(dbCreds.host.split(':')[0]);
  const hostMappedPort = process.env.MYSQL_HOST_PORT
    ? Number(process.env.MYSQL_HOST_PORT)
    : (process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : (dbCreds.port ?? 3306));
  let finalDbCreds = dbCreds;
  if (isLocalHost) {
    console.log(`[Deploy] DB host is Docker-internal — using 127.0.0.1:${hostMappedPort} for VPS PM2 process`);
    finalDbCreds = { ...dbCreds, host: '127.0.0.1', port: hostMappedPort };
  }

  console.log(`\n[Deploy] Step 1 — Create GitHub repo`);
  const repo = await createGithubRepo(finalRepoName);

  console.log(`\n[Deploy] Step 2 — Push to GitHub`);
  const commitSha = await initAndPush({
    workDir: generatedDir,
    repoCloneUrl: repo.cloneUrl,
    branch,
    message: `feat: initial React migration [jobId=${jobId}]`,
  });

  console.log(`\n[Deploy] Step 3 — Deploy backend to VPS`);
  const { backendPort } = await deployBackendToVps({ workDir: generatedDir, siteDir: finalRepoName, dbCreds: finalDbCreds });

  console.log(`\n[Deploy] Step 4 — Deploy frontend to VPS`);
  const { frontendUrl } = await deployFrontendToVps({ workDir: generatedDir, siteDir: finalRepoName, backendPort });

  const result = {
    jobId,
    repoName: finalRepoName,
    githubUrl: repo.htmlUrl,
    frontendUrl,
    backendPort,
    commitSha,
  };

  console.log(`\n[Deploy] ── Done ────────────────────────────────────────`);
  console.log(`  GitHub   : ${repo.htmlUrl}`);
  console.log(`  Frontend : ${frontendUrl}`);
  console.log(`  Backend  : port ${backendPort}`);

  return result;
}

async function redeployFrontend({ jobId, repoName, branch = 'main' }) {
  console.log(`\n[Redeploy] ── Start jobId=${jobId} ─────────────────────────`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  if (!VPS_HOST) throw new Error('VPS_HOST is not configured');

  const generatedDir = path.join(AI_PIPELINE_GENERATED_DIR, jobId);
  if (!(await fse.pathExists(generatedDir))) {
    throw new Error(`Generated directory not found for jobId: ${jobId}`);
  }

  console.log(`\n[Redeploy] Step 1 — Push delta to GitHub`);
  const repo = await createGithubRepo(repoName);
  await initAndPush({
    workDir: generatedDir,
    repoCloneUrl: repo.cloneUrl,
    branch,
    message: `fix: visual edit update [jobId=${jobId}]`,
  });

  console.log(`\n[Redeploy] Step 2 — Build & upload frontend`);
  const backendPort = sitePort(repoName);
  const { frontendUrl } = await deployFrontendToVps({ workDir: generatedDir, siteDir: repoName, backendPort });

  console.log(`\n[Redeploy] ── Done — Frontend: ${frontendUrl} ────────────`);
  return { jobId, repoName, githubUrl: repo.htmlUrl, frontendUrl };
}

module.exports = { deployFullStack, pushToGit, redeployFrontend };
