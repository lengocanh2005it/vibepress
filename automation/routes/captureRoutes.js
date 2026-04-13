const express = require('express');
const { captureRegion, saveCapture, deleteCapturesBySite, getCapturesBySite } = require('../controllers/captureController');

const router = express.Router();

router.post('/wp/capture', captureRegion);
router.post('/captures/save', saveCapture);
router.post('/captures/:siteId', deleteCapturesBySite);
router.get('/captures/:siteId', getCapturesBySite);

module.exports = router;
