const express = require('express');
const { deployJob, pushToGitJob } = require('../controllers/deployController');

const router = express.Router();

// POST /api/deploy
// Body: { jobId, repoName?, branch?, dbCreds? | dbInfo? }
router.post('/deploy', deployJob);

// POST /api/deploy/push-git
// Body: { jobId, repoName?, branch? }
// Chỉ tạo GitHub repo + push code, trả về githubUrl
router.post('/deploy/push-git', pushToGitJob);

module.exports = router;
