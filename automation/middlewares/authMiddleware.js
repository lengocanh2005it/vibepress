const jwt = require('jsonwebtoken');
const { queryOne } = require('../db/mysql');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

/**
 * Middleware: validates Bearer JWT, attaches req.user = { id, email, apiKey }
 */
async function requireAuth(req, res, next) {
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
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  req.user = { id: user.id, email: user.email, apiKey: user.api_key };
  next();
}

module.exports = { requireAuth };
