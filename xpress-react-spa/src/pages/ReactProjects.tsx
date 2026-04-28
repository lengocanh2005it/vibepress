import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import TopNav from '../components/TopNav';

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

  return (
    <div className="min-h-screen bg-[#faf6f0] text-[#2e3230] antialiased">
      <TopNav />

      <div className="pt-[72px] flex h-screen overflow-hidden">

        {/* ── Featured panel (left) ─────────────────────────────── */}
        <div className="relative flex-1 overflow-hidden">

          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-[#4a4e4a]/40 text-sm animate-pulse">Đang tải...</span>
            </div>
          ) : !active ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <FolderOpen size={56} className="text-[#4a7c59]/20" />
              <p className="text-[#4a4e4a]/50 text-sm">Chưa có dự án React nào được migrate.</p>
            </div>
          ) : (
            <>
              {/* Thumbnail background */}
              <div
                className="absolute inset-0 bg-cover bg-center transition-all duration-700"
                style={{ backgroundImage: `url(${active.thumbnail_url || FALLBACK})` }}
              />
              {/* Gradient overlays — warm tone phù hợp với palette dự án */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#faf6f0] via-[#faf6f0]/40 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#faf6f0]/60 to-transparent" />

              {/* Content */}
              <div className="relative z-10 flex flex-col justify-end h-full px-12 pb-14">
                {/* Big number */}
                <span
                  className="font-headline font-extrabold leading-none mb-3 select-none text-[#2e3230]/10"
                  style={{ fontSize: 'clamp(88px, 13vw, 168px)' }}
                >
                  {String(items.indexOf(active) + 1).padStart(2, '0')}
                </span>

                {/* Badge */}
                <span className="inline-flex items-center gap-1.5 bg-[#4a7c59]/10 text-[#4a7c59] text-xs font-bold px-3 py-1 rounded-full w-fit mb-3 border border-[#4a7c59]/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4a7c59] animate-pulse" />
                  React Site
                </span>

                <h1
                  className="font-headline font-extrabold text-[#2e3230] mb-2 leading-tight"
                  style={{ fontSize: 'clamp(26px, 3vw, 46px)' }}
                >
                  {active.site_name || active.site_url || 'Unnamed site'}
                </h1>

                <p className="text-[#4a4e4a]/60 text-sm mb-6">
                  Migrated {formatDate(active.created_at)}
                </p>

                <div className="flex gap-3 flex-wrap">
                  {active.deployed_url && (
                    <a
                      href={active.deployed_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-[#4a7c59] text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-md hover:bg-[#3d6b4c] transition-colors"
                    >
                      <ExternalLink size={15} />
                      Visit Site
                    </a>
                  )}
                  {active.github_repo_url && (
                    <a
                      href={active.github_repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 border border-[#4a7c59]/30 text-[#4a7c59] bg-white/70 backdrop-blur-sm font-semibold text-sm px-5 py-2.5 rounded-xl hover:bg-[#4a7c59]/5 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[15px]">code</span>
                      GitHub
                    </a>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── List panel (right) ────────────────────────────────── */}
        <div className="w-[320px] shrink-0 flex flex-col overflow-y-auto border-l border-[#e8e4dc] bg-white/60 backdrop-blur-sm">

          <div className="px-5 py-4 border-b border-[#e8e4dc] bg-white/80 sticky top-0 z-10">
            <h2 className="text-[#2e3230] font-headline font-bold text-base">React Projects</h2>
            <p className="text-[#4a4e4a]/50 text-xs mt-0.5">{items.length} dự án đã migrate</p>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-[#4a4e4a]/30 text-xs animate-pulse">Đang tải...</span>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[#f0ece4]">
              {items.map((item, idx) => {
                const isActive = item.id === active?.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActive(item)}
                    className={`relative flex gap-3 p-4 text-left transition-all group ${
                      isActive
                        ? 'bg-[#4a7c59]/8 border-l-[3px] border-[#4a7c59]'
                        : 'hover:bg-[#f5f2eb] border-l-[3px] border-transparent'
                    }`}
                  >
                    {/* Thumbnail */}
                    <div className="relative w-[84px] h-[56px] shrink-0 rounded-lg overflow-hidden border border-[#e8e4dc]">
                      <img
                        src={item.thumbnail_url || FALLBACK}
                        alt={item.site_name || ''}
                        className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).src = FALLBACK; }}
                      />
                      <span className={`absolute bottom-1 right-1.5 text-[10px] font-bold leading-none px-1 py-0.5 rounded ${
                        isActive ? 'bg-[#4a7c59] text-white' : 'bg-black/40 text-white/80'
                      }`}>
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                    </div>

                    {/* Info */}
                    <div className="flex flex-col justify-center min-w-0">
                      <p className={`text-sm font-semibold truncate leading-snug ${
                        isActive ? 'text-[#2e3230]' : 'text-[#4a4e4a] group-hover:text-[#2e3230]'
                      }`}>
                        {item.site_name || item.site_url || 'Unnamed site'}
                      </p>
                      <p className="text-[#4a4e4a]/50 text-xs mt-0.5">
                        {formatDate(item.created_at)}
                      </p>
                      {item.deployed_url && (
                        <p className="text-[#4a7c59]/50 text-[11px] mt-1 truncate">
                          {item.deployed_url.replace(/^https?:\/\//, '')}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
