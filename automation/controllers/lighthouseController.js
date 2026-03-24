const { runLighthouseAudit } = require('../services/lighthouseService');

async function auditLighthouse(req, res) {
	const { url, formFactor, throttlingMethod, runs } = req.body || {};

	if (!url) {
		return res.status(400).json({
			success: false,
			code: 'INVALID_REQUEST',
			message: 'url is required',
		});
	}

	try {
		const result = await runLighthouseAudit(url, {
			formFactor: formFactor || 'desktop',
			throttlingMethod: throttlingMethod || 'simulate',
			runs: runs || 1,
		});
		return res.status(200).json({ success: true, result });
	} catch (error) {
		return res.status(500).json({
			success: false,
			code: 'LIGHTHOUSE_AUDIT_FAILED',
			message: error.message || 'Failed to run Lighthouse audit',
		});
	}
}

module.exports = {
	auditLighthouse,
};
