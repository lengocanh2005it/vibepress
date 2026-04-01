const express = require('express');
const { deployJob } = require('../controllers/deployController');

const router = express.Router();

// POST /api/deploy
// Body: { jobId, repoUrl, branch?, accessToken? }
router.post('/deploy', deployJob);

module.exports = router;
