const path = require('path');
const fse = require('fs-extra');
const axios = require('axios');
const { simpleGit } = require('simple-git');
const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  VERCEL_TOKEN,
  RENDER_API_KEY,
  RENDER_OWNER_ID,
  TEMP_ROOT,
  PUBLIC_DB_HOST,
  PUBLIC_DB_PORT,
} = require('../config/constants');

const AI_PIPELINE_GENERATED_DIR = path.resolve(
  __dirname,
  '../../ai-pipeline/temp/generated',
);

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
    '**/node_modules/',
    '**/.env',
    '**/.env.*',
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

async function commitAndPush({ workDir, branch, message }) {
  console.log(`[Git] Commit & push — ${message}`);
  const git = simpleGit(workDir);

  await git.add('.');
  const status = await git.status();
  console.log(`[Git] Files changed: ${status.files.length}`);

  if (status.files.length === 0) {
    console.log(`[Git] Nothing to commit, skipping`);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? '';
  }

  await git.commit(message);
  await git.push('origin', branch);

  const log = await git.log({ maxCount: 1 });
  const sha = log.latest?.hash ?? '';
  console.log(`[Git] Pushed — commit: ${sha}`);
  return sha;
}

// ── Render ────────────────────────────────────────────────────────────────────

async function createRenderService({ repoName, repoHtmlUrl, branch = 'main', dbCreds = {} }) {
  if (!RENDER_API_KEY) throw new Error('RENDER_API_KEY is not configured');
  if (!RENDER_OWNER_ID) throw new Error('RENDER_OWNER_ID is not configured');

  const serviceName = `api-${repoName.slice(0, 40)}`;
  console.log(`[Render] Creating web service: ${serviceName}`);

  const payload = {
    type: 'web_service',
    name: serviceName,
    ownerId: RENDER_OWNER_ID,
    repo: repoHtmlUrl,
    branch,
    rootDir: 'server',
    serviceDetails: {
      env: 'node',
      plan: 'free',
      envVars: [
        { key: 'DB_HOST',     value: dbCreds.host     ?? 'localhost' },
        { key: 'DB_PORT',     value: String(dbCreds.port ?? 3306)    },
        { key: 'DB_USER',     value: dbCreds.user     ?? 'root'      },
        { key: 'DB_PASSWORD', value: dbCreds.password ?? ''          },
        { key: 'DB_NAME',     value: dbCreds.dbName   ?? 'wordpress' },
        { key: 'NODE_ENV',    value: 'production'                    },
      ],
      envSpecificDetails: {
        buildCommand: 'npm install',
        startCommand: 'npm start',
      },
    },
  };
  console.log(`[Render] Payload:`, JSON.stringify(payload, null, 2));

  let res;
  try {
    res = await axios.post('https://api.render.com/v1/services', payload, {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error(`[Render] API error ${err.response?.status}:`, JSON.stringify(err.response?.data, null, 2));
    throw new Error(`Render API failed (${err.response?.status}): ${JSON.stringify(err.response?.data)}`);
  }

  const serviceId = res.data.service?.id;
  const renderUrl = `https://${serviceName}.onrender.com`;
  console.log(`[Render] Service created — id: ${serviceId}, url: ${renderUrl}`);

  // Set env vars riêng vì creation payload không phải lúc nào cũng apply
  if (serviceId) {
    const envVars = [
      { key: 'DB_HOST',     value: dbCreds.host     ?? 'localhost' },
      { key: 'DB_PORT',     value: String(dbCreds.port ?? 3306)    },
      { key: 'DB_USER',     value: dbCreds.user     ?? 'root'      },
      { key: 'DB_PASSWORD', value: dbCreds.password ?? ''          },
      { key: 'DB_NAME',     value: dbCreds.dbName   ?? 'wordpress' },
      { key: 'NODE_ENV',    value: 'production'                    },
    ];
    try {
      await axios.put(
        `https://api.render.com/v1/services/${serviceId}/env-vars`,
        envVars.map(v => ({ key: v.key, value: String(v.value) })),
        { headers: { Authorization: `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' } },
      );
      console.log(`[Render] Env vars set for service: ${serviceId}`);
    } catch (err) {
      console.warn(`[Render] Failed to set env vars: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    }
  }

  return { serviceId, renderUrl };
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async function createVercelProject({ repoName, branch = 'main', githubOwner }) {
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN is not configured');

  console.log(`[Vercel] Creating project: ${repoName} (branch: ${branch})`);

  const payload = {
    name: repoName,
    framework: 'vite',
    rootDirectory: 'frontend',
    gitRepository: {
      type: 'github',
      repo: `${githubOwner}/${repoName}`,
      productionBranch: branch,
    },
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
    installCommand: 'npm install',
  };
  console.log(`[Vercel] Payload:`, JSON.stringify(payload, null, 2));

  let res;
  try {
    res = await axios.post('https://api.vercel.com/v10/projects', payload, {
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error(`[Vercel] API error ${err.response?.status}:`, JSON.stringify(err.response?.data, null, 2));
    throw new Error(`Vercel API failed (${err.response?.status}): ${JSON.stringify(err.response?.data)}`);
  }

  const projectId = res.data.id;
  const vercelUrl = `https://${repoName}.vercel.app`;
  console.log(`[Vercel] Project created — id: ${projectId}, url: ${vercelUrl}`);

  return { projectId, vercelUrl };
}

async function setVercelEnvVars({ projectId }) {
  const vercelHeaders = { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' };
  const envVars = [
    { key: 'VITE_BASE',     value: '/',    type: 'plain', target: ['production', 'preview'] },
    { key: 'VITE_API_BASE', value: '/api', type: 'plain', target: ['production', 'preview'] },
  ];
  try {
    await axios.post(
      `https://api.vercel.com/v10/projects/${projectId}/env`,
      envVars,
      { headers: vercelHeaders },
    );
    console.log(`[Vercel] Env vars set for project: ${projectId}`);
  } catch (err) {
    console.warn(`[Vercel] Failed to set env vars: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
  }
}

async function triggerVercelDeployment({ repoName, branch, githubOwner }) {
  // Trigger deployment thủ công vì project tạo sau khi push → Vercel không tự deploy
  console.log(`[Vercel] Triggering deployment for branch: ${branch}`);
  try {
    const deployRes = await axios.post(
      'https://api.vercel.com/v13/deployments',
      {
        name: repoName,
        gitSource: {
          type: 'github',
          org: githubOwner,
          repo: repoName,
          ref: branch,
        },
        projectSettings: {
          framework: 'vite',
          rootDirectory: 'frontend',
          buildCommand: 'npm run build',
          outputDirectory: 'dist',
          installCommand: 'npm install',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    console.log(`[Vercel] Deployment triggered — id: ${deployRes.data.id}, state: ${deployRes.data.readyState}`);
  } catch (err) {
    console.warn(`[Vercel] Trigger deployment warning (${err.response?.status}):`, JSON.stringify(err.response?.data, null, 2));
  }
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

  // 2. Copy generated code → workDir
  const workDir = path.join(TEMP_ROOT, `deploy_${jobId}`);
  await fse.remove(workDir);
  await fse.copy(generatedDir, workDir);
  console.log(`[PushToGit] Copied to: ${workDir}`);

  // 3. Push lên GitHub
  const commitSha = await initAndPush({
    workDir,
    repoCloneUrl: repo.cloneUrl,
    branch,
    message: `feat: initial React migration [jobId=${jobId}]`,
  });

  await fse.remove(workDir);
  console.log(`\n[PushToGit] ── Done — GitHub: ${repo.htmlUrl} ──────────`);

  return {
    jobId,
    repoName: finalRepoName,
    githubUrl: repo.htmlUrl,
    commitSha,
  };
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function deployFullStack({ jobId, repoName, branch = 'main', dbCreds = {} }) {
  console.log(`\n[Deploy] ── Start jobId=${jobId} ──────────────────────`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN is not configured');
  if (!RENDER_API_KEY) throw new Error('RENDER_API_KEY is not configured');
  if (!RENDER_OWNER_ID) throw new Error('RENDER_OWNER_ID is not configured');

  const githubHeaders = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
  const githubOwner = await getGithubOwner(githubHeaders);

  const generatedDir = path.join(AI_PIPELINE_GENERATED_DIR, jobId);
  console.log(`[Deploy] Checking generated dir: ${generatedDir}`);
  if (!(await fse.pathExists(generatedDir))) {
    throw new Error(`Generated directory not found for jobId: ${jobId}`);
  }

  const finalRepoName = repoName || `react-migration-${jobId.slice(0, 8)}`;
  console.log(`[Deploy] Repo name: ${finalRepoName}`);

  // 1. Tạo GitHub repo
  console.log(`\n[Deploy] Step 1/6 — Create GitHub repo`);
  const repo = await createGithubRepo(finalRepoName);

  // 2. Copy generated code → workDir
  console.log(`\n[Deploy] Step 2/6 — Copy generated files`);
  const workDir = path.join(TEMP_ROOT, `deploy_${jobId}`);
  await fse.remove(workDir);
  await fse.copy(generatedDir, workDir);
  console.log(`[Deploy] Copied to: ${workDir}`);

  // 3. Push lần 1 lên GitHub
  console.log(`\n[Deploy] Step 3/6 — Push to GitHub`);
  await initAndPush({
    workDir,
    repoCloneUrl: repo.cloneUrl,
    branch,
    message: `feat: initial React migration [jobId=${jobId}]`,
  });

  // 4. Deploy server lên Render
  console.log(`\n[Deploy] Step 4/6 — Deploy server to Render`);

  // Nếu host là Docker internal hostname → resolve sang PUBLIC_DB_HOST
  const DOCKER_INTERNAL_HOSTS = ['localhost', '127.0.0.1', 'db', 'mysql'];
  const isLocalHost = !dbCreds.host || DOCKER_INTERNAL_HOSTS.includes(dbCreds.host.split(':')[0]);
  let finalDbCreds = dbCreds;
  if (isLocalHost) {
    if (!PUBLIC_DB_HOST) throw new Error('DB host is internal but PUBLIC_DB_HOST is not configured');
    console.log(`[Deploy] DB host "${dbCreds.host}" is internal — using PUBLIC_DB_HOST: ${PUBLIC_DB_HOST}:${PUBLIC_DB_PORT ?? dbCreds.port}`);
    finalDbCreds = { ...dbCreds, host: PUBLIC_DB_HOST, ...(PUBLIC_DB_PORT && { port: PUBLIC_DB_PORT }) };
  }

  const { renderUrl, serviceId } = await createRenderService({
    repoName: finalRepoName,
    repoHtmlUrl: repo.htmlUrl,
    branch,
    dbCreds: finalDbCreds,
  });

  // 5. Update vercel.json với Render URL
  console.log(`\n[Deploy] Step 5/6 — Update vercel.json with Render URL`);
  const vercelJsonPath = path.join(workDir, 'frontend', 'vercel.json');
  if (await fse.pathExists(vercelJsonPath)) {
    let content = await fse.readFile(vercelJsonPath, 'utf8');
    content = content.replace(/__RENDER_API_URL__/g, renderUrl);
    await fse.writeFile(vercelJsonPath, content);
    console.log(`[Deploy] vercel.json updated — API URL: ${renderUrl}`);
  } else {
    console.warn(`[Deploy] vercel.json not found at ${vercelJsonPath}, skipping`);
  }

  // 6. Push lần 2 với vercel.json đã update
  console.log(`\n[Deploy] Step 6/6 — Push updated vercel.json`);
  const commitSha = await commitAndPush({
    workDir,
    branch,
    message: `chore: set Render API URL in vercel.json [jobId=${jobId}]`,
  });

  // 7. Tạo Vercel project + set env vars + trigger deploy
  console.log(`\n[Deploy] Step 7/6 — Create Vercel project`);
  const { projectId, vercelUrl } = await createVercelProject({ repoName: finalRepoName, branch, githubOwner });

  console.log(`\n[Deploy] Step 7b — Set Vercel env vars`);
  await setVercelEnvVars({ projectId });

  console.log(`\n[Deploy] Step 7c — Trigger Vercel deployment`);
  await triggerVercelDeployment({ repoName: finalRepoName, branch, githubOwner });

  await fse.remove(workDir);
  console.log(`\n[Deploy] ── Done ───────────────────────────────────────`);
  console.log(`  GitHub : ${repo.htmlUrl}`);
  console.log(`  Render : ${renderUrl}`);
  console.log(`  Vercel : ${vercelUrl}`);

  return {
    jobId,
    repoName: finalRepoName,
    githubUrl: repo.htmlUrl,
    renderUrl,
    vercelUrl,
    commitSha,
  };
}

module.exports = { deployFullStack, pushToGit };
