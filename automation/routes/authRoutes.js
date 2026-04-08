const express = require('express');
const { register, login, me } = require('../controllers/authController');

const router = express.Router();

router.post('/auth/register', register);
router.post('/auth/login',    login);
router.get('/auth/me',        me);

module.exports = router;
