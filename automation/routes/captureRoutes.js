const express = require('express');
const { captureRegion } = require('../controllers/captureController');

const router = express.Router();

router.post('/wp/capture', captureRegion);

module.exports = router;
