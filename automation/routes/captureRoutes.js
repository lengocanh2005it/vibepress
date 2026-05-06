const express = require('express');
const { captureRegion, saveCapture, deleteCapturesBySite, getCapturesBySite, uploadImage } = require('../controllers/captureController');

const router = express.Router();

router.post('/wp/capture', captureRegion);
router.post('/captures/save', saveCapture);
router.post('/captures/:siteId', deleteCapturesBySite);
router.get('/captures/:siteId', getCapturesBySite);

router.post('/upload-image', uploadImage);

module.exports = router;
