const wpExtract = require('wpress-extract');
const fse = require('fs-extra');

async function extractWpress(wpressPath, outputDir) {
	await fse.ensureDir(outputDir);

	let extractedCount = 0;

	await wpExtract({
		inputFile: wpressPath,
		outputDir,
		override: true,
		onStart: () => {},
		onUpdate: () => {},
		onFinish: (count) => {
			extractedCount = count;
		},
	});

	return extractedCount;
}

module.exports = { extractWpress };
