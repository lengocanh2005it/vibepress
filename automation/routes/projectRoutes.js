const express = require('express');
const upload = require('../middlewares/uploadMiddleware');
const { requireAuth } = require('../middlewares/authMiddleware');
const { createProject, getProjectById, uploadTheme, registerWpSite, getToken, syncComplete, getReposByEmail, getCommitsByRepo, getWpSitePages, proxyWpPage, proxyWpAsset, notifyContentChange, notifyCommentChange, getDBinfoBySiteId, getSqlDumpTables, getSqlDumpRows, getSqlDumpFullTable, getSqlDumpAll, createSiteDb } = require('../controllers/projectController');

const router = express.Router();

router.post('/create-project', createProject);
router.get('/project/:projectId', getProjectById);
router.post('/upload-theme', upload.single('wpressFile'), uploadTheme);
router.post('/wp/register', registerWpSite);
router.post('/wp/get-token', getToken);
router.post('/wp/sync-complete', syncComplete);
router.post('/wp/notify-content-change', notifyContentChange);
router.post('/wp/notify-comment-change', notifyCommentChange);
router.get('/wp/repos', requireAuth, getReposByEmail);
router.get('/wp/commits', getCommitsByRepo);
router.get('/wp/site-pages', getWpSitePages);
router.get('/wp/proxy', proxyWpPage);
router.get('/wp/proxy-asset', proxyWpAsset);
router.get('/wp/db-info-by-site', getDBinfoBySiteId);
router.get('/wp/sql-dump/tables', getSqlDumpTables);
router.get('/wp/sql-dump/full', getSqlDumpFullTable);
router.get('/wp/sql-dump/all', getSqlDumpAll);
router.get('/wp/sql-dump', getSqlDumpRows);
router.post('/wp/create-db', createSiteDb);

module.exports = router;
