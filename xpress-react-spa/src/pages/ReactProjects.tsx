import { useEffect, useState } from 'react';

interface Migration {
  id: string;
  site_id: string;
  job_id: string;
  github_repo_url: string | null;
  deployed_url: string | null;
  thumbnail_url: string | null;
  created_at: string;
  site_name: string | null;
  site_url: string | null;
}

const FALLBACK = 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric' });
}

export default function ReactProjects() {
  const [items, setItems]     = useState<Migration[]>([]);
  const [active, setActive]   = useState<Migration | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/migrations')
      .then(r => r.json())
      .then((data: Migration[]) => {
        setItems(data);
        setActive(data[0] ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <span className="text-white/40 text-sm animate-pulse">Đang tải...</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex flex-col items-center justify-center gap-3">
        <span className="material-symbols-outlined text-white/20 text-[64px]">folder_open</span>
        <p className="text-white/40 text-sm">Chưa có dự án React nào được migrate.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d1117] flex overflow-hidden" style={{ fontFamily: 'Inter, sans-serif' }}>

      {/* ── Featured panel (left) ─────────────────────────────────── */}
      <div className="relative flex-1 min-h-screen overflow-hidden">
        {/* Background image */}
        <div
          className="absolute inset-0 bg-cover bg-center transition-all duration-700"
          style={{ backgroundImage: `url(${active?.thumbnail_url || FALLBACK})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/20 to-transparent" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-end h-full p-10 pb-14">
          <span className="text-white/20 font-bold leading-none mb-4 select-none"
            style={{ fontSize: 'clamp(80px, 12vw, 160px)' }}>
            {String(items.indexOf(active!) + 1).padStart(2, '0')}
          </span>

          <h1 className="text-white font-bold mb-2 leading-tight"
            style={{ fontSize: 'clamp(24px, 3vw, 42px)' }}>
            {active?.site_name || active?.site_url || 'Unnamed site'}
          </h1>

          <p className="text-white/50 text-sm mb-6">
            {active ? formatDate(active.created_at) : ''}
          </p>

          <div className="flex gap-3">
            {active?.deployed_url && (
              <a
                href={active.deployed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-white text-[#0d1117] font-semibold text-sm px-5 py-2.5 rounded-full hover:bg-white/90 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                Visit Site
              </a>
            )}
            {active?.github_repo_url && (
              <a
                href={active.github_repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 border border-white/30 text-white text-sm px-5 py-2.5 rounded-full hover:bg-white/10 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">code</span>
                GitHub
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ── List panel (right) ────────────────────────────────────── */}
      <div className="w-[340px] shrink-0 flex flex-col overflow-y-auto bg-black/30 backdrop-blur-sm border-l border-white/5">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="text-white/60 text-xs font-semibold uppercase tracking-widest">
            React Projects
          </h2>
          <p className="text-white/30 text-xs mt-0.5">{items.length} dự án</p>
        </div>

        <div className="flex flex-col divide-y divide-white/5">
          {items.map((item, idx) => {
            const isActive = item.id === active?.id;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item)}
                className={`relative flex gap-3 p-4 text-left transition-colors group ${
                  isActive ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                {/* Thumbnail */}
                <div className="relative w-[88px] h-[58px] shrink-0 rounded-lg overflow-hidden">
                  <img
                    src={item.thumbnail_url || FALLBACK}
                    alt={item.site_name || ''}
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).src = FALLBACK; }}
                  />
                  {/* Number overlay */}
                  <span className="absolute top-1 right-1.5 text-white/70 font-bold text-[11px] leading-none">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                </div>

                {/* Info */}
                <div className="flex flex-col justify-center min-w-0">
                  <p className={`text-sm font-semibold truncate leading-snug ${isActive ? 'text-white' : 'text-white/70 group-hover:text-white'}`}>
                    {item.site_name || item.site_url || 'Unnamed site'}
                  </p>
                  <p className="text-white/35 text-xs mt-0.5">
                    {formatDate(item.created_at)}
                  </p>
                  {item.deployed_url && (
                    <p className="text-white/25 text-[11px] mt-1 truncate">
                      {item.deployed_url.replace(/^https?:\/\//, '')}
                    </p>
                  )}
                </div>

                {/* Active indicator */}
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 bg-white rounded-r-full" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
