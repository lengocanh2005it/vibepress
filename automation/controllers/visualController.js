const { compareWebVisuals, compareMultiplePages } = require('../services/visualService');

function parseOptionalNumber(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

async function compareVisual(req, res) {
	const { urlA, urlB, fullPage, viewportWidth, viewportHeight } = req.body || {};

	if (!urlA || !urlB) {
		return res.status(400).json({
			success: false,
			code: 'INVALID_REQUEST',
			message: 'urlA and urlB are required',
		});
	}

	try {
		const result = await compareWebVisuals({
			urlA,
			urlB,
			fullPage: fullPage !== false,
			viewportWidth: parseOptionalNumber(viewportWidth, 1440),
			viewportHeight: parseOptionalNumber(viewportHeight, 900),
		});

		return res.status(200).json({
			success: true,
			result,
		});
	} catch (error) {
		return res.status(500).json({
			success: false,
			code: 'VISUAL_COMPARE_FAILED',
			message: error.message || 'Failed to compare visuals',
		});
	}
}

async function compareMultipleVisuals(req,res) {
	const {
		urlA,
		urlB,
		fullPage,
		viewportWidth,
		viewportHeight,
	} = req.body || {};

	const effectiveWpBaseUrl = urlA; 
	const effectiveReactBaseUrl = urlB;

	if (!effectiveWpBaseUrl || !effectiveReactBaseUrl) {
		return res.status(400).json({
			success: false,
			code: 'INVALID_REQUEST',
			message: 'wpBaseUrl/reactBaseUrl (or urlA/urlB) are required',
		});
	}

	try {
		const result = await compareMultiplePages({
			wpBaseUrl: effectiveWpBaseUrl,
			reactBaseUrl: effectiveReactBaseUrl,
			fullPage: fullPage !== false,
			viewportWidth: parseOptionalNumber(viewportWidth, 1440),
			viewportHeight: parseOptionalNumber(viewportHeight, 900),
		});

		return res.status(200).json({
			success: true,
			result,
		});
	} catch (error) {
		return res.status(500).json({
			success: false,
			code: 'VISUAL_COMPARE_FAILED',
			message: error.message || 'Failed to compare visuals',
		});
	}
}

module.exports = {
	compareVisual,
	compareMultipleVisuals,
};
