require('dotenv').config();
const path = require('path');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || null;
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'MVP Bot';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'mvp-bot@example.com';
const AI_PIPELINE_PORT = process.env.AI_PIPELINE_PORT || '3001';
const AI_PIPELINE_URL = `http://localhost:${AI_PIPELINE_PORT}`;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || null;
const RENDER_API_KEY = process.env.RENDER_API_KEY || null;
const RENDER_OWNER_ID = process.env.RENDER_OWNER_ID || null;
const PUBLIC_DB_HOST = process.env.PUBLIC_DB_HOST || null;
const PUBLIC_DB_PORT = process.env.PUBLIC_DB_PORT ? Number(process.env.PUBLIC_DB_PORT) : null;
const RENDER_DB_USER = process.env.RENDER_DB_USER || null;
const RENDER_DB_PASSWORD = process.env.RENDER_DB_PASSWORD ?? null;
// VPS deploy
const VPS_HOST = process.env.VPS_HOST || null;
const VPS_USER = process.env.VPS_USER || null;
const VPS_SSH_KEY_PATH = process.env.VPS_SSH_KEY_PATH || null;
const VPS_SSH_PASSWORD = process.env.VPS_SSH_PASSWORD || null;
const VPS_FRONTEND_DIR = process.env.VPS_FRONTEND_DIR || '/var/www/sites';
const VPS_BACKEND_DIR = process.env.VPS_BACKEND_DIR || '/var/apps/sites';
const VPS_DOMAIN = process.env.VPS_DOMAIN || null;
const VPS_BACKEND_BASE_PORT = process.env.VPS_BACKEND_BASE_PORT
  ? parseInt(process.env.VPS_BACKEND_BASE_PORT, 10)
  : 4000;

const CLOUD_IMAGE_PROVIDER = process.env.CLOUD_IMAGE_PROVIDER || null;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || null;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || null;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'captures';
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY || null;
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || null;
const IMAGEKIT_FOLDER = process.env.IMAGEKIT_FOLDER || '/captures';

const BASE_DIR = __dirname + '/..';
const DB_FILE = path.join(BASE_DIR, 'db.json');
const TEMP_ROOT = path.join(BASE_DIR, 'temp_workspaces');
const UPLOAD_ROOT = path.join(BASE_DIR, 'uploads');

const corsOptions = {
	origin: CORS_ORIGIN,
	methods: ['GET', 'POST', 'PUT'],
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
	AI_PIPELINE_URL,
	VERCEL_TOKEN,
	RENDER_API_KEY,
	RENDER_OWNER_ID,
	PUBLIC_DB_HOST,
	PUBLIC_DB_PORT,
	RENDER_DB_USER,
	RENDER_DB_PASSWORD,
	VPS_HOST,
	VPS_USER,
	VPS_SSH_KEY_PATH,
	VPS_SSH_PASSWORD,
	VPS_FRONTEND_DIR,
	VPS_BACKEND_DIR,
	VPS_DOMAIN,
	VPS_BACKEND_BASE_PORT,
	CLOUD_IMAGE_PROVIDER,
	CLOUDINARY_CLOUD_NAME,
	CLOUDINARY_API_KEY,
	CLOUDINARY_API_SECRET,
	CLOUDINARY_FOLDER,
	IMAGEKIT_PUBLIC_KEY,
	IMAGEKIT_PRIVATE_KEY,
	IMAGEKIT_FOLDER,
	DB_FILE,

	TEMP_ROOT,
	UPLOAD_ROOT,
	corsOptions,
};
