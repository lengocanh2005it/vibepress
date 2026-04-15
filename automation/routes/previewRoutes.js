const express = require('express');
const { registerPreview, unregisterPreview, proxyPreview } = require('../controllers/previewController');

const router = express.Router();

// AI pipeline gọi để đăng ký / huỷ preview
router.post('/preview/register', registerPreview);
router.delete('/preview/:pipelineId', unregisterPreview);

module.exports = router;

// Route proxy riêng — mount ở /preview thay vì /api/preview
// vì Nginx forward /preview/:pipelineId/* vào đây
const proxyRouter = express.Router();
proxyRouter.get('/:pipelineId', proxyPreview);
proxyRouter.get('/:pipelineId/*splat', proxyPreview);

module.exports.proxyRouter = proxyRouter;
