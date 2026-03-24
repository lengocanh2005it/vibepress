const express = require('express');
const { auditLighthouse } = require('../controllers/lighthouseController');

const router = express.Router();

router.post('/lighthouse/audit', auditLighthouse);

module.exports = router;
