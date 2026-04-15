const express = require('express');
const cors = require('cors');
const { PORT, corsOptions } = require('./config/constants');
const systemRoutes = require('./routes/systemRoutes');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const visualRoutes = require('./routes/visualRoutes');
const lighthouseRoutes = require('./routes/lighthouseRoutes');
const captureRoutes = require('./routes/captureRoutes');
const contentRoutes = require('./routes/contentRoutes');
const siteCompareRoutes = require('./routes/siteCompareRoutes');
const deployRoutes = require('./routes/deployRoutes');
const wpPresetRoutes = require('./routes/wpPresetRoutes');
const { ensureFileSystemState } = require('./controllers/projectController');

const app = express();

app.use(express.json());

app.use(cors(corsOptions));
app.options('/{*splat}', cors(corsOptions));

app.use('/', systemRoutes);
app.use('/api', authRoutes);
app.use('/api', projectRoutes);
app.use('/api', visualRoutes);
app.use('/api', lighthouseRoutes);
app.use('/api', captureRoutes);
app.use('/api', contentRoutes);
app.use('/api', siteCompareRoutes);
app.use('/api', deployRoutes);
app.use('/api', wpPresetRoutes);
app.use('/captures', express.static(require('path').join(__dirname, 'uploads/captures')));
app.use('/artifacts', express.static(require('path').join(__dirname, 'artifacts')));

ensureFileSystemState();

if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`Server is running at http://localhost:${PORT}`);
	});
}

module.exports = app;
