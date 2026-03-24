const express = require('express');
const upload = require('../middlewares/uploadMiddleware');
const { createProject, getProjectById, uploadTheme, registerWpSite, getWpSiteKey } = require('../controllers/projectController');

const router = express.Router();

router.post('/create-project', createProject);
router.get('/project/:projectId', getProjectById);
router.post('/upload-theme', upload.single('wpressFile'), uploadTheme);
router.post('/wp/register', registerWpSite);

module.exports = router;
