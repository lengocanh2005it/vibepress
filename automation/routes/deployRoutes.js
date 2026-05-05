const express = require('express');
const { deployJob, pushToGitJob, checkSubdomain, redeployJob } = require('../controllers/deployController');

const router = express.Router();

// POST /api/deploy
// Body: { jobId, repoName?, branch?, dbCreds? | dbInfo? }
router.post('/deploy', deployJob);

// POST /api/deploy/push-git
// Body: { jobId, repoName?, branch? }
// Chỉ tạo GitHub repo + push code, trả về githubUrl
router.post('/deploy/push-git', pushToGitJob);

// GET /api/deploy/check-subdomain?subdomain=<name>
router.get('/deploy/check-subdomain', checkSubdomain);

// POST /api/deploy/redeploy
// Body: { jobId, siteId }
// Chỉ push code lên GitHub + build frontend + upload dist/ lên VPS, bỏ qua backend
router.post('/deploy/redeploy', redeployJob);

module.exports = router;
