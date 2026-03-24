const multer = require('multer');
const { UPLOAD_ROOT } = require('../config/constants');

const upload = multer({
	dest: UPLOAD_ROOT,
	limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB — wpress files can be large
});

module.exports = upload;
