const express = require('express');
const { root, health } = require('../controllers/systemController');

const router = express.Router();

router.get('/', root);
router.get('/health', health);

module.exports = router;
