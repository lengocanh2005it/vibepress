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
} = require('../config/constants');

const AI_PIPELINE_GENERATED_DIR = path.resolve(
  __dirname,
  '../../ai-pipeline/temp/generated',
);

// ── Ngrok ─────────────────────────────────────────────────────────────────────

async function getMysqlNgrokTunnel() {
  console.log(`[Ngrok] Fetching active tunnels from localhost:4040...`);
  let tunnels;
  try {
    const res = await axios.get('http://localhost:4040/api/tunnels');
    tunnels = res.data.tunnels;
  } catch {
    throw new Error('Ngrok is not running. Start it with: ngrok tcp 3306');
  }

  // Tìm tunnel TCP trỏ vào port 3306
  const tunnel = tunnels.find(
    (t) => t.proto === 'tcp' && t.config?.addr?.toString().endsWith('3306'),
  );

  if (!tunnel) {
    throw new Error('No ngrok TCP tunnel found for port 3306. Run: ngrok tcp 3306');
  }

  // public_url dạng: tcp://0.tcp.ngrok.io:12345
  const publicUrl = tunnel.public_url;
  const [host, port] = publicUrl.replace('tcp://', '').split(':');
  console.log(`[Ngrok] MySQL tunnel found — ${host}:${port}`);
  return { host, port: Number(port) };
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async function createGithubRepo(repoName) {
  console.log(`[GitHub] Creating repo: ${repoName}`);
  const res = await axios.post(
    'https://api.github.com/user/repos',
    { name: repoName, private: true, auto_init: false },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  console.log(`[GitHub] Repo created: ${res.data.html_url}`);
  return { name: res.data.name, htmlUrl: res.data.html_url, cloneUrl: res.data.clone_url };
}

async function initAndPush({ workDir, repoCloneUrl, branch, message }) {
  console.log(`[Git] Init & push to branch "${branch}" — ${message}`);
  const authedUrl = repoCloneUrl.replace(
    'https://',
    `https://x-access-token:${encodeURIComponent(GITHUB_TOKEN)}@`,
  );
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
  await git.push('origin', branch, ['--set-upstream']);

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
  return { serviceId, renderUrl };
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async function createVercelProject({ repoName, branch = 'main' }) {
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN is not configured');

  console.log(`[Vercel] Creating project: ${repoName} (branch: ${branch})`);

  const payload = {
    name: repoName,
    framework: 'vite',
    rootDirectory: 'frontend',
    gitRepository: {
      type: 'github',
      repo: `${GITHUB_OWNER}/${repoName}`,
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

  // Trigger deployment thủ công vì project tạo sau khi push → Vercel không tự deploy
  console.log(`[Vercel] Triggering deployment for branch: ${branch}`);
  try {
    const deployRes = await axios.post(
      'https://api.vercel.com/v13/deployments',
      {
        name: repoName,
        gitSource: {
          type: 'github',
          org: GITHUB_OWNER,
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

  return { projectId, vercelUrl };
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function deployFullStack({ jobId, repoName, branch = 'main', dbCreds = {} }) {
  console.log(`\n[Deploy] ── Start jobId=${jobId} ──────────────────────`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  if (!GITHUB_OWNER) throw new Error('GITHUB_OWNER is not configured');

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

  // Nếu host là Docker internal (không public) → dùng ngrok tunnel thay thế
  const isLocalHost = !dbCreds.host || ['localhost', '127.0.0.1', 'db'].includes(dbCreds.host.split(':')[0]);
  let finalDbCreds = dbCreds;
  if (isLocalHost) {
    console.log(`[Deploy] DB host "${dbCreds.host}" is local — fetching ngrok tunnel...`);
    const { host, port } = await getMysqlNgrokTunnel();
    finalDbCreds = { ...dbCreds, host, port };
  }

  const { renderUrl } = await createRenderService({
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

  // 7. Tạo Vercel project
  console.log(`\n[Deploy] Step 7/6 — Create Vercel project`);
  const { vercelUrl } = await createVercelProject({ repoName: finalRepoName, branch });

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

module.exports = { deployFullStack };
