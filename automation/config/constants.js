require('dotenv').config();
const path = require('path');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || null;
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MVP Bot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'mvp-bot@example.com';

const BASE_DIR = __dirname + '/..';
const DB_FILE = path.join(BASE_DIR, 'db.json');
const TEMP_ROOT = path.join(BASE_DIR, 'temp_workspaces');
const UPLOAD_ROOT = path.join(BASE_DIR, 'uploads');

const corsOptions = {
	origin: CORS_ORIGIN,
	methods: ['GET', 'POST', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization'],
	optionsSuccessStatus: 204,
};

module.exports = {
	PORT,
	CORS_ORIGIN,
	GITHUB_TOKEN,
	GITHUB_OWNER,
	GIT_AUTHOR_NAME,
	GIT_AUTHOR_EMAIL,
	DB_FILE,
	TEMP_ROOT,
	UPLOAD_ROOT,
	corsOptions,
};
