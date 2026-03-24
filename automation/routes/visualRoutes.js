const express = require('express');
const { compareVisual, compareMultipleVisuals } = require('../controllers/visualController');

const router = express.Router();

router.post('/visual/compare', compareVisual);
router.post('/visual/compare-multiple', compareMultipleVisuals);

module.exports = router;
