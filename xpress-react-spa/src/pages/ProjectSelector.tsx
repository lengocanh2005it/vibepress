import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';
import { getRepoByEmail, getCommitHistory } from '../services/automationService';

interface Repository {
  siteId: string;
  siteUrl: string;
  siteName: string | null;
  wpRepoName: string;
  wpRepoUrl: string;
  registeredAt: string;
}

interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
  avatarUrl: string | null;
}

interface Page {
  name: string;
  path: string;
  lastSync: string;
  status: 'live' | 'draft';
}

const pages: Page[] = [
  { name: 'Landing Page',     path: '/index.html',            lastSync: '2 mins ago', status: 'live'  },
  { name: 'Product Features', path: '/features/ai-sync.html', lastSync: '1 hour ago', status: 'live'  },
  { name: 'Pricing Plans',    path: '/pricing.html',          lastSync: 'Yesterday',  status: 'draft' },
  { name: 'Contact Support',  path: '/support/contact.html',  lastSync: '3 days ago', status: 'live'  },
];

const ProjectSelector: React.FC = () => {
  const navigate = useNavigate();
  const { email } = useUser();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [commitHistory, setCommitHistory] = useState<Commit[]>([]);

  useEffect(() => {
    if (!email) return;
    getRepoByEmail(email)
      .then(data => setRepositories(data))
      .catch(err => console.error('Error fetching repos:', err));
  }, [email]);

  useEffect(() => {
    if (!selectedRepo) return;
    getCommitHistory(selectedRepo.wpRepoUrl)
      .then(data => setCommitHistory(data))
      .catch(err => console.error('Error fetching commit history:', err));
  }, [selectedRepo]);

  return (
    <div className="flex-1 w-full max-w-[1400px] mx-auto px-8 py-10 flex gap-8">

      {/* Left Sidebar (Repos) */}
      <aside className="w-80 shrink-0 flex flex-col gap-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-headline text-[20px] font-bold text-[#1a2b21]">Connected Repositories</h2>
          <span className="material-symbols-outlined text-[#5c6860] cursor-pointer">link</span>
        </div>

        <div className="flex flex-col gap-4">
          {repositories.length > 0 ? (
            repositories.map((repo) => {
              const isSelected = selectedRepo?.siteId === repo.siteId;
              return (
                <div
                  key={repo.siteId}
                  onClick={() => setSelectedRepo(repo)}
                  className={`bg-[#e8e6df]/50 border-2 rounded-3xl p-6 cursor-pointer transition-all ${isSelected ? 'border-[#49704F]' : 'border-transparent hover:border-[#dcd9ce]'}`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="material-symbols-outlined text-[#233227] text-[20px]">folder_zip</span>
                    <h3 className="font-bold text-[#233227] text-[15px]">{repo.siteName || repo.wpRepoName}</h3>
                  </div>
                  <p className="font-mono text-[11px] text-[#8e9892] mb-6">{repo.wpRepoUrl.replace('https://', '')}</p>
                  <div className="flex justify-between items-center mt-auto">
                    <span className="bg-[#c2e4cc] text-[#2c6e49] text-[10px] uppercase font-bold tracking-widest px-3 py-1 rounded-full">Connected</span>
                    <span className="text-[11px] text-[#8e9892]">{new Date(repo.registeredAt).toLocaleDateString()}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-[#8e9892] text-[13px] px-2">
              {email ? 'Đang tải repositories...' : 'Vui lòng đăng nhập để xem repositories.'}
            </p>
          )}

          {/* Connect New */}
          <button className="bg-transparent border-2 border-dashed border-[#dcd9ce] rounded-full p-4 flex items-center justify-center gap-2 text-[#5c6860] font-bold text-[14px] hover:bg-[#e8e6df]/50 transition-colors">
            <span className="material-symbols-outlined text-[18px]">add</span> Connect New Repository
          </button>
        </div>

        {/* Total Assets Widget */}
        <div className="mt-auto bg-[#594d3f] rounded-[2rem] p-8 text-[#f4ead5] relative overflow-hidden shadow-xl">
          <h4 className="text-[13px] font-medium opacity-80 mb-2">Total Assets Hosted</h4>
          <p className="font-headline text-[38px] font-bold leading-none">1.2 GB</p>
          <span className="material-symbols-outlined text-[120px] absolute -bottom-6 -right-6 opacity-10 rotate-12">cloud_done</span>
        </div>
      </aside>

      {/* Right Content */}
      <main className="flex-1 flex flex-col gap-6">

        {/* Page Manager */}
        <div className="bg-[#FAF7F0] rounded-[2.5rem] p-8 border border-[#e8e6df] shadow-[0_8px_30px_rgba(0,0,0,0.02)]">
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="font-headline text-[22px] font-bold text-[#1a2b21] mb-1">Page Manager</h2>
              <p className="text-[#5c6860] text-[14px]">
                {selectedRepo ? `Repo: ${selectedRepo.siteName || selectedRepo.wpRepoName}` : 'Chọn một repository để xem'}
              </p>
            </div>
            <div className="flex gap-3">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#8e9892] text-[18px]">search</span>
                <input
                  type="text"
                  placeholder="Filter pages..."
                  className="bg-[#e8e6df]/50 border-none rounded-full pl-11 pr-6 py-2.5 text-[14px] w-64 focus:ring-2 focus:ring-[#49704F]/30 outline-none text-[#233227] placeholder:text-[#8e9892]"
                />
              </div>
              <button className="w-10 h-10 bg-[#e8e6df]/50 rounded-full flex items-center justify-center text-[#5c6860] hover:bg-[#dcd9ce] transition-colors">
                <span className="material-symbols-outlined text-[20px]">filter_list</span>
              </button>
            </div>
          </div>

          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] font-bold text-[#8e9892] uppercase tracking-widest border-b border-[#e8e6df]">
                <th className="pb-4 font-medium pl-2">Page Name</th>
                <th className="pb-4 font-medium">Path</th>
                <th className="pb-4 font-medium">Last Sync</th>
                <th className="pb-4 font-medium">Status</th>
                <th className="pb-4"></th>
              </tr>
            </thead>
            <tbody className="text-[14px] text-[#233227]">
              {pages.map((page, index) => (
                <tr
                  key={page.path}
                  className={`${index < pages.length - 1 ? 'border-b border-[#e8e6df]/50' : ''} hover:bg-[#e8e6df]/20 transition-colors group cursor-pointer`}
                  onClick={() => navigate('/app/editor', { state: { siteUrl: selectedRepo?.siteUrl } })}
                >
                  <td className="py-5 pl-2 font-medium">{page.name}</td>
                  <td className="py-5 font-mono text-[12px] text-[#5c6860]">{page.path}</td>
                  <td className="py-5 text-[#5c6860] text-[13px]">{page.lastSync}</td>
                  <td className="py-5">
                    {page.status === 'live' ? (
                      <span className="inline-flex items-center gap-1.5 bg-opacity-50 text-[#14b8a6] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#d2f3e8]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#14b8a6] shadow-[0_0_8px_#14b8a6]"></span>
                        Live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 bg-[#f5efe6] text-[#b88c42] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#eedfc9]">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="py-5 text-right w-12">
                    <span className="material-symbols-outlined text-[#8e9892] opacity-0 group-hover:opacity-100 transition-opacity">more_vert</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-6 text-center">
            <button className="text-[13px] font-bold text-[#233227] hover:text-[#49704F] transition-colors">View All Pages</button>
          </div>
        </div>

        {/* Git Activity */}
        <div className="bg-[#FAF7F0] rounded-[2.5rem] p-8 border border-[#e8e6df] shadow-[0_8px_30px_rgba(0,0,0,0.02)]">
          <div className="flex justify-between items-start mb-8">
            <div>
              <h2 className="font-headline text-[20px] font-bold text-[#1a2b21] mb-1">Git Activity</h2>
              <p className="text-[#5c6860] text-[14px]">
                {selectedRepo ? `${selectedRepo.siteName || selectedRepo.wpRepoName} — main branch` : 'Main branch history'}
              </p>
            </div>
            <span className="material-symbols-outlined text-[#8e9892]">history</span>
          </div>

          <div className="space-y-6">
            {commitHistory.length > 0 ? (
              commitHistory.map((commit, index) => {
                const isMerge = commit.message.toLowerCase().startsWith('merge');
                const isLast = index === commitHistory.length - 1;
                return (
                  <div key={commit.sha} className="flex gap-4">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10 relative ${isMerge ? 'bg-[#f0eede] text-[#8e9892] border border-[#e6e2cd]' : 'bg-[#e1ecd6] text-[#49704F] border border-[#d2dfc6]'}`}>
                      <span className="material-symbols-outlined text-[16px]">{isMerge ? 'merge' : 'commit'}</span>
                      {!isLast && <div className="absolute top-8 left-1/2 -ml-px w-0.5 h-10 bg-[#e8e6df] -z-10"></div>}
                    </div>
                    <div className="pt-1">
                      <div className="flex items-center gap-3 mb-2">
                        <p className="text-[14px] font-bold text-[#233227]">{commit.message}</p>
                        <span className="font-mono text-[10px] bg-[#e8e6df] text-[#5c6860] px-2 py-0.5 rounded border border-[#dcd9ce]">{commit.sha.slice(0, 7)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[12px] text-[#8e9892]">
                        {commit.avatarUrl && <img src={commit.avatarUrl} alt={commit.author} className="w-4 h-4 rounded-full" />}
                        <span className="font-medium text-[#5c6860]">{commit.author}</span>
                        <span>•</span>
                        <span>{new Date(commit.date).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-[#8e9892] text-[13px]">
                {selectedRepo ? 'Đang tải lịch sử commit...' : 'Chọn một repository để xem Git Activity.'}
              </p>
            )}
          </div>
        </div>
      </main>

    </div>
  );
};

export default ProjectSelector;
