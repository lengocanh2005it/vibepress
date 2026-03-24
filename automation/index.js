const express = require('express');
const cors = require('cors');
const { PORT, corsOptions } = require('./config/constants');
const systemRoutes = require('./routes/systemRoutes');
const projectRoutes = require('./routes/projectRoutes');
const visualRoutes = require('./routes/visualRoutes');
const lighthouseRoutes = require('./routes/lighthouseRoutes');
const { ensureFileSystemState } = require('./controllers/projectController');

const app = express();

app.use(express.json());

app.use(cors(corsOptions));
app.options('/{*splat}', cors(corsOptions));

app.use('/', systemRoutes);
app.use('/api', projectRoutes);
app.use('/api', visualRoutes);
app.use('/api', lighthouseRoutes);

ensureFileSystemState();

if (require.main === module) {
	app.listen(PORT, () => {
		console.log(`Server is running at http://localhost:${PORT}`);
	});
}

module.exports = app;
