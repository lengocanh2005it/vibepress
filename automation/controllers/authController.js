const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query, queryOne } = require('../db/mysql');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const BCRYPT_ROUNDS = 10;

function generateId() {
  return `user-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function generateApiKey() {
  return `vp_${crypto.randomBytes(24).toString('hex')}`;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' },
  );
}

// -------------------------------------------------------
// POST /api/auth/register
// Body: { email, password }
// -------------------------------------------------------
async function register(req, res) {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email và password là bắt buộc' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'Password phải có ít nhất 6 ký tự' });
  }

  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).json({ success: false, error: 'Email đã được sử dụng' });
  }

  const id           = generateId();
  const apiKey       = generateApiKey();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await query(
    'INSERT INTO users (id, email, password_hash, api_key) VALUES (?, ?, ?, ?)',
    [id, email, passwordHash, apiKey],
  );

  const token = signToken({ id, email });

  return res.status(201).json({
    success: true,
    token,
    user: { id, email, apiKey },
  });
}

// -------------------------------------------------------
// POST /api/auth/login
// Body: { email, password }
// -------------------------------------------------------
async function login(req, res) {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email và password là bắt buộc' });
  }

  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Email hoặc mật khẩu không đúng' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Email hoặc mật khẩu không đúng' });
  }

  const token = signToken({ id: user.id, email: user.email });

  return res.status(200).json({
    success: true,
    token,
    user: { id: user.id, email: user.email, apiKey: user.api_key },
  });
}

// -------------------------------------------------------
// GET /api/auth/me
// Header: Authorization: Bearer <token>
// -------------------------------------------------------
async function me(req, res) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn' });
  }

  const user = await queryOne('SELECT id, email, api_key FROM users WHERE id = ?', [payload.id]);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User không tồn tại' });
  }

  return res.status(200).json({
    success: true,
    user: { id: user.id, email: user.email, apiKey: user.api_key },
  });
}

module.exports = { register, login, me };
