function buildLighthouseSettings(formFactor, throttlingMethod) {
	if (formFactor === 'mobile') {
		return {
			onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
			formFactor: 'mobile',
			screenEmulation: {
				mobile: true,
				width: 390,
				height: 844,
				deviceScaleFactor: 2,
				disabled: false,
			},
			emulatedUserAgent:
				'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
			throttlingMethod,
		};
	}

	return {
		onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
		formFactor: 'desktop',
		screenEmulation: {
			mobile: false,
			width: 1350,
			height: 940,
			deviceScaleFactor: 1,
			disabled: false,
		},
		emulatedUserAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
		throttlingMethod,
	};
}

function toPercent(score) {
	return Math.round((Number(score || 0) || 0) * 100);
}

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
	}
	return sorted[mid];
}

async function runSingleAudit(lighthouse, url, settings) {
	const chromeLauncher = await import('chrome-launcher');
	const chrome = await chromeLauncher.launch({
		chromeFlags: ['--headless', '--disable-gpu', '--no-sandbox'],
	});

	try {
		const result = await lighthouse(
			url,
			{
				port: chrome.port,
				output: 'json',
				logLevel: 'error',
				...settings,
			},
			{
				extends: 'lighthouse:default',
			},
		);

		const lhr = result?.lhr;
		if (!lhr) {
			throw new Error('Cannot read Lighthouse report');
		}

		const categories = lhr.categories || {};
		const audits = lhr.audits || {};

		return {
			requestedUrl: lhr.requestedUrl,
			finalUrl: lhr.finalUrl,
			fetchTime: lhr.fetchTime,
			scores: {
				performance: toPercent(categories.performance?.score),
				accessibility: toPercent(categories.accessibility?.score),
				bestPractices: toPercent(categories['best-practices']?.score),
				seo: toPercent(categories.seo?.score),
			},
			metrics: {
				firstContentfulPaint: audits['first-contentful-paint']?.displayValue || null,
				largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || null,
				totalBlockingTime: audits['total-blocking-time']?.displayValue || null,
				cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue || null,
				speedIndex: audits['speed-index']?.displayValue || null,
			},
		};
	} finally {
		await chrome.kill();
	}
}

async function runLighthouseAudit(url, options = {}) {
	const formFactor = options.formFactor || 'desktop';
	const throttlingMethod =
		options.throttlingMethod || (formFactor === 'desktop' ? 'provided' : 'simulate');
	const runs = Math.min(Math.max(Number(options.runs) || 1, 1), 5);

	if (!url) {
		const error = new Error('url is required');
		error.code = 'INVALID_REQUEST';
		throw error;
	}

	const { default: lighthouse } = await import('lighthouse');
	const settings = buildLighthouseSettings(formFactor, throttlingMethod);
	const runResults = [];

	for (let i = 0; i < runs; i += 1) {
		const run = await runSingleAudit(lighthouse, url, settings);
		runResults.push(run);
	}

	const performanceScores = runResults.map((run) => toNumber(run.scores.performance));
	const accessibilityScores = runResults.map((run) => toNumber(run.scores.accessibility));
	const bestPracticeScores = runResults.map((run) => toNumber(run.scores.bestPractices));
	const seoScores = runResults.map((run) => toNumber(run.scores.seo));

	const stableResult = runResults[runResults.length - 1];

	return {
		requestedUrl: stableResult.requestedUrl,
		finalUrl: stableResult.finalUrl,
		fetchTime: stableResult.fetchTime,
		formFactor,
		throttlingMethod,
		runs,
		scores: {
			performance: median(performanceScores),
			accessibility: median(accessibilityScores),
			bestPractices: median(bestPracticeScores),
			seo: median(seoScores),
		},
		metrics: stableResult.metrics,
		runScores: runResults.map((run) => run.scores),
	};
}

module.exports = {
	runLighthouseAudit,
};
