const express = require('express');
const { listPresets, getPresetById } = require('../controllers/wpPresetController');

const router = express.Router();

router.get('/wp-presets', listPresets);
router.get('/wp-presets/:id', getPresetById);

module.exports = router;
