const express = require('express');
const upload = require('../middlewares/uploadMiddleware');
const { createProject, getProjectById, uploadTheme, registerWpSite, getToken, syncComplete } = require('../controllers/projectController');

const router = express.Router();

router.post('/create-project', createProject);
router.get('/project/:projectId', getProjectById);
router.post('/upload-theme', upload.single('wpressFile'), uploadTheme);
router.post('/wp/register', registerWpSite);
router.post('/wp/get-token', getToken);
router.post('/wp/sync-complete', syncComplete);

module.exports = router;
