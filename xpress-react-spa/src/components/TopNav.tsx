import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';

type AuthTab = 'login' | 'register';

interface TopNavProps {
  /** Optional: caller can receive the openAuthModal fn to trigger it externally */
  registerOpenAuth?: (fn: (tab?: AuthTab) => void) => void;
}

const TopNav: React.FC<TopNavProps> = ({ registerOpenAuth }) => {
  const navigate = useNavigate();
  const { user, setAuth, clearAuth } = useUser();

  // ── Auth modal state ──────────────────────────────────────────────────────
  const [showModal, setShowModal]     = useState(false);
  const [tab, setTab]                 = useState<AuthTab>('login');
  const [fields, setFields]           = useState({ email: '', password: '', confirmPassword: '' });
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  // ── API Key modal state ───────────────────────────────────────────────────
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyCopied, setApiKeyCopied]       = useState(false);

  const openModal = (defaultTab: AuthTab = 'login') => {
    setTab(defaultTab);
    setFields({ email: '', password: '', confirmPassword: '' });
    setError('');
    setShowModal(true);
  };

  // Expose openModal to parent if needed
  useEffect(() => {
    registerOpenAuth?.(openModal);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerOpenAuth]);

  const handleField = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (tab === 'register' && fields.password !== fields.confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }

    setLoading(true);
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fields.email, password: fields.password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Đã có lỗi xảy ra');
        return;
      }

      setAuth(data.user, data.token);
      setShowModal(false);
    } catch {
      setError('Không thể kết nối đến server');
    } finally {
      setLoading(false);
    }
  };

  const copyApiKey = () => {
    if (!user?.apiKey) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(user.apiKey);
    } else {
      const el = document.createElement('textarea');
      el.value = user.apiKey;
      el.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setApiKeyCopied(true);
    setTimeout(() => setApiKeyCopied(false), 2000);
  };

  return (
    <>
      {/* ── Nav bar ─────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 bg-[#faf6f0]/80 backdrop-blur-md border-b border-[#4a7c59]/10 shadow-[0_4px_20px_rgba(46,50,48,0.06)]">
        <div className="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto">
          <div className="flex items-center gap-8">
            <button
              onClick={() => navigate('/')}
              className="font-headline text-2xl font-bold text-[#4a7c59] hover:opacity-80 transition-opacity"
            >
              X-press
            </button>
            <div className="hidden md:flex gap-6 font-semibold text-sm">
              <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Product</a>
              <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Features</a>
              <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Pricing</a>
              <a href="/template-store" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Template</a>
              {user && (
                <button
                  onClick={() => setShowApiKeyModal(true)}
                  className="text-stone-600 hover:text-[#4a7c59] transition-colors font-semibold text-sm"
                >
                  API Key
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <span className="text-stone-600 font-semibold text-sm">Xin chào, {user.email}</span>
                <button
                  onClick={clearAuth}
                  className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
                >
                  Đăng xuất
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openModal('login')}
                  className="text-stone-600 font-semibold text-sm hover:opacity-80 transition-opacity"
                >
                  Đăng nhập
                </button>
                <button
                  onClick={() => openModal('register')}
                  className="border border-[#4a7c59] text-[#4a7c59] px-4 py-1.5 rounded-lg font-semibold text-sm hover:bg-[#4a7c59]/5 transition-colors"
                >
                  Đăng ký
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ── API Key Modal ────────────────────────────────────────────────── */}
      {showApiKeyModal && user && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowApiKeyModal(false)}
        >
          <div
            className="bg-[#faf6f0] rounded-2xl shadow-2xl p-8 w-full max-w-md mx-4"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-headline text-xl font-bold text-[#2e3230] mb-1">API Key của bạn</h2>
            <p className="text-sm text-[#4a4e4a] mb-6">
              Dùng key này để kết nối WordPress plugin với Vibepress.
            </p>

            <div className="flex items-center gap-2 bg-white border border-[#c4c8bc] rounded-xl px-4 py-3 mb-4">
              <code className="flex-1 text-sm text-[#2e3230] break-all select-all">{user.apiKey}</code>
              <button
                onClick={copyApiKey}
                className="flex-shrink-0 text-[#4a7c59] hover:opacity-70 transition-opacity"
                title="Copy"
              >
                <span className="material-symbols-outlined text-xl">
                  {apiKeyCopied ? 'check' : 'content_copy'}
                </span>
              </button>
            </div>

            {apiKeyCopied && <p className="text-xs text-[#4a7c59] mb-4">Đã copy!</p>}

            <button
              onClick={() => setShowApiKeyModal(false)}
              className="w-full text-center text-xs text-stone-400 hover:text-stone-600 transition-colors"
            >
              Đóng
            </button>
          </div>
        </div>
      )}

      {/* ── Auth Modal ───────────────────────────────────────────────────── */}
      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-[#faf6f0] rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4"
            onClick={e => e.stopPropagation()}
          >
            {/* Tabs */}
            <div className="flex mb-6 bg-[#f0ece4] rounded-xl p-1">
              <button
                onClick={() => { setTab('login'); setError(''); }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  tab === 'login'
                    ? 'bg-white text-[#2e3230] shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                Đăng nhập
              </button>
              <button
                onClick={() => { setTab('register'); setError(''); }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  tab === 'register'
                    ? 'bg-white text-[#2e3230] shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                Đăng ký
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                name="email"
                type="email"
                required
                autoFocus
                placeholder="Email"
                value={fields.email}
                onChange={handleField}
                className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
              />
              <input
                name="password"
                type="password"
                required
                placeholder="Mật khẩu"
                value={fields.password}
                onChange={handleField}
                className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
              />
              {tab === 'register' && (
                <input
                  name="confirmPassword"
                  type="password"
                  required
                  placeholder="Xác nhận mật khẩu"
                  value={fields.confirmPassword}
                  onChange={handleField}
                  className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
                />
              )}

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#4a7c59] text-white py-3 rounded-xl font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {loading ? 'Đang xử lý...' : tab === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
              </button>
            </form>

            <button
              onClick={() => setShowModal(false)}
              className="mt-4 w-full text-center text-xs text-stone-400 hover:text-stone-600 transition-colors"
            >
              Huỷ
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default TopNav;
