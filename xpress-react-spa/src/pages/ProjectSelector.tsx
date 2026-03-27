import React from 'react';
import { useNavigate } from 'react-router-dom';

const ProjectSelector: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="flex-1 w-full max-w-[1400px] mx-auto px-8 py-10 flex gap-8">
      
      {/* Left Sidebar (Repos) */}
      <aside className="w-80 shrink-0 flex flex-col gap-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-headline text-[20px] font-bold text-[#1a2b21]">Connected Repositories</h2>
          <span className="material-symbols-outlined text-[#5c6860] cursor-pointer">link</span>
        </div>

        <div className="flex flex-col gap-4">
          
          {/* Active Repo */}
          <div className="bg-[#e8e6df]/50 border-2 border-transparent hover:border-[#dcd9ce] rounded-3xl p-6 cursor-pointer transition-all">
            <div className="flex items-center gap-3 mb-2">
              <span className="material-symbols-outlined text-[#233227] text-[20px]">folder_zip</span>
              <h3 className="font-bold text-[#233227] text-[15px]">marketing-portal-v2</h3>
            </div>
            <p className="font-mono text-[11px] text-[#8e9892] mb-6">github.com/xpress-ai/marketing-portal-v2</p>
            <div className="flex justify-between items-center mt-auto">
              <span className="bg-[#c2e4cc] text-[#2c6e49] text-[10px] uppercase font-bold tracking-widest px-3 py-1 rounded-full">Active Host</span>
              <span className="text-[13px] font-bold text-[#5c6860]">24 Pages</span>
            </div>
          </div>

          {/* Staging Repo */}
          <div className="bg-[#e8e6df]/50 border-2 border-transparent hover:border-[#dcd9ce] rounded-3xl p-6 cursor-pointer transition-all opacity-70 hover:opacity-100">
            <div className="flex items-center gap-3 mb-2">
              <span className="material-symbols-outlined text-[#5c6860] text-[20px]">folder</span>
              <h3 className="font-bold text-[#5c6860] text-[15px]">documentation-core</h3>
            </div>
            <p className="font-mono text-[11px] text-[#8e9892] mb-6">github.com/xpress-ai/docs-core</p>
            <div className="flex justify-between items-center mt-auto">
              <span className="bg-[#e8e6df] text-[#8e9892] text-[10px] uppercase font-bold tracking-widest px-3 py-1 rounded-full">Staging</span>
              <span className="text-[13px] font-bold text-[#5c6860]">112 Pages</span>
            </div>
          </div>

          {/* Archived Repo */}
          <div className="bg-[#e8e6df]/50 border-2 border-transparent hover:border-[#dcd9ce] rounded-3xl p-6 cursor-pointer transition-all opacity-50 hover:opacity-100">
            <div className="flex items-center gap-3 mb-2">
              <span className="material-symbols-outlined text-[#5c6860] text-[20px]">folder</span>
              <h3 className="font-bold text-[#5c6860] text-[15px]">legacy-blog-archive</h3>
            </div>
            <p className="font-mono text-[11px] text-[#8e9892] mb-6">github.com/archive/blog-2022</p>
            <div className="flex justify-between items-center mt-auto">
              <span className="bg-[#e8e6df] text-[#8e9892] text-[10px] uppercase font-bold tracking-widest px-3 py-1 rounded-full">Archived</span>
              <span className="text-[13px] font-bold text-[#5c6860]">542 Pages</span>
            </div>
          </div>

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
              <p className="text-[#5c6860] text-[14px]">Managing 24 pages in marketing-portal-v2</p>
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
              
              {/* Row 1 */}
              <tr className="border-b border-[#e8e6df]/50 hover:bg-[#e8e6df]/20 transition-colors group cursor-pointer" onClick={() => navigate('/app/editor')}>
                <td className="py-5 pl-2 font-medium">Landing Page</td>
                <td className="py-5 font-mono text-[12px] text-[#5c6860]">/index.html</td>
                <td className="py-5 text-[#5c6860] text-[13px]">2 mins ago</td>
                <td className="py-5">
                  <span className="inline-flex items-center gap-1.5 bg-[#effrf5] bg-opacity-50 text-[#14b8a6] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#d2f3e8]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#14b8a6] shadow-[0_0_8px_#14b8a6]"></span> Live
                  </span>
                </td>
                <td className="py-5 text-right w-12">
                  <span className="material-symbols-outlined text-[#8e9892] opacity-0 group-hover:opacity-100 transition-opacity">more_vert</span>
                </td>
              </tr>

              {/* Row 2 */}
              <tr className="border-b border-[#e8e6df]/50 hover:bg-[#e8e6df]/20 transition-colors group cursor-pointer" onClick={() => navigate('/app/editor')}>
                <td className="py-5 pl-2 font-medium">Product Features</td>
                <td className="py-5 font-mono text-[12px] text-[#5c6860]">/features/ai-sync.html</td>
                <td className="py-5 text-[#5c6860] text-[13px]">1 hour ago</td>
                <td className="py-5">
                  <span className="inline-flex items-center gap-1.5 bg-[#effrf5] bg-opacity-50 text-[#14b8a6] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#d2f3e8]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#14b8a6] shadow-[0_0_8px_#14b8a6]"></span> Live
                  </span>
                </td>
                <td className="py-5 text-right w-12">
                  <span className="material-symbols-outlined text-[#8e9892] opacity-0 group-hover:opacity-100 transition-opacity">more_vert</span>
                </td>
              </tr>

              {/* Row 3 */}
              <tr className="border-b border-[#e8e6df]/50 hover:bg-[#e8e6df]/20 transition-colors group cursor-pointer" onClick={() => navigate('/app/editor')}>
                <td className="py-5 pl-2 font-medium">Pricing Plans</td>
                <td className="py-5 font-mono text-[12px] text-[#5c6860]">/pricing.html</td>
                <td className="py-5 text-[#5c6860] text-[13px]">Yesterday</td>
                <td className="py-5">
                  <span className="inline-flex items-center gap-1.5 bg-[#f5efe6] text-[#b88c42] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#eedfc9]">
                    Draft
                  </span>
                </td>
                <td className="py-5 text-right w-12">
                  <span className="material-symbols-outlined text-[#8e9892] opacity-0 group-hover:opacity-100 transition-opacity">more_vert</span>
                </td>
              </tr>

               {/* Row 4 */}
               <tr className="hover:bg-[#e8e6df]/20 transition-colors group cursor-pointer" onClick={() => navigate('/app/editor')}>
                <td className="py-5 pl-2 font-medium">Contact Support</td>
                <td className="py-5 font-mono text-[12px] text-[#5c6860]">/support/contact.html</td>
                <td className="py-5 text-[#5c6860] text-[13px]">3 days ago</td>
                <td className="py-5">
                  <span className="inline-flex items-center gap-1.5 bg-[#effrf5] bg-opacity-50 text-[#14b8a6] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[#d2f3e8]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#14b8a6] shadow-[0_0_8px_#14b8a6]"></span> Live
                  </span>
                </td>
                <td className="py-5 text-right w-12">
                  <span className="material-symbols-outlined text-[#8e9892] opacity-0 group-hover:opacity-100 transition-opacity">more_vert</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="mt-6 text-center">
            <button className="text-[13px] font-bold text-[#233227] hover:text-[#49704F] transition-colors">View All 24 Pages</button>
          </div>
        </div>

        {/* Git Activity */}
        <div className="bg-[#FAF7F0] rounded-[2.5rem] p-8 border border-[#e8e6df] shadow-[0_8px_30px_rgba(0,0,0,0.02)]">
          <div className="flex justify-between items-start mb-8">
            <div>
              <h2 className="font-headline text-[20px] font-bold text-[#1a2b21] mb-1">Git Activity</h2>
              <p className="text-[#5c6860] text-[14px]">Main branch history</p>
            </div>
            <span className="material-symbols-outlined text-[#8e9892]">history</span>
          </div>

          <div className="space-y-6">
            
            {/* Commit 1 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-[#e1ecd6] text-[#49704F] flex items-center justify-center shrink-0 border border-[#d2dfc6] z-10 relative">
                <span className="material-symbols-outlined text-[16px]">commit</span>
                <div className="absolute top-8 left-1/2 -ml-px w-0.5 h-10 bg-[#e8e6df] -z-10"></div>
              </div>
              <div className="pt-1">
                <div className="flex items-center gap-3 mb-2">
                  <p className="text-[14px] font-bold text-[#233227]">Updated hero section copy for conversion</p>
                  <span className="font-mono text-[10px] bg-[#e8e6df] text-[#5c6860] px-2 py-0.5 rounded border border-[#dcd9ce]">a2b4c1d</span>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[#8e9892]">
                  <img src="https://i.pravatar.cc/150?u=a042581f4e29026704d" alt="Alex" className="w-4 h-4 rounded-full" />
                  <span className="font-medium text-[#5c6860]">Alex Thompson</span>
                  <span>•</span>
                  <span>Today, 11:24 AM</span>
                </div>
              </div>
            </div>

            {/* Commit 2 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-[#f0eede] text-[#8e9892] flex items-center justify-center shrink-0 border border-[#e6e2cd] z-10 relative">
                <span className="material-symbols-outlined text-[16px]">merge</span>
                <div className="absolute top-8 left-1/2 -ml-px w-0.5 h-10 bg-[#e8e6df] -z-10"></div>
              </div>
              <div className="pt-1">
                <div className="flex items-center gap-3 mb-2">
                  <p className="text-[14px] font-bold text-[#233227]">Merge pull request #114 from xpress/fix/nav-offset</p>
                  <span className="font-mono text-[10px] bg-[#e8e6df] text-[#5c6860] px-2 py-0.5 rounded border border-[#dcd9ce]">9f8e7d6</span>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[#8e9892]">
                  <img src="https://i.pravatar.cc/150?u=a04258114e29026702d" alt="Sarah" className="w-4 h-4 rounded-full" />
                  <span className="font-medium text-[#5c6860]">Sarah Chen</span>
                  <span>•</span>
                  <span>Yesterday, 4:45 PM</span>
                </div>
              </div>
            </div>

            {/* Commit 3 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-[#f0eede] text-[#8e9892] flex items-center justify-center shrink-0 border border-[#e6e2cd] z-10">
                <span className="material-symbols-outlined text-[16px]">commit</span>
              </div>
              <div className="pt-1">
                <div className="flex items-center gap-3 mb-2">
                  <p className="text-[14px] font-bold text-[#233227]">Initial deployment of documentation-core submodule</p>
                  <span className="font-mono text-[10px] bg-[#e8e6df] text-[#5c6860] px-2 py-0.5 rounded border border-[#dcd9ce]">e5f4d3c</span>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[#8e9892]">
                  <img src="https://i.pravatar.cc/150?u=a042581f4e29026704d" alt="Alex" className="w-4 h-4 rounded-full" />
                  <span className="font-medium text-[#5c6860]">Alex Thompson</span>
                  <span>•</span>
                  <span>Oct 12, 10:15 AM</span>
                </div>
              </div>
            </div>

          </div>
        </div>
      </main>

    </div>
  );
};

export default ProjectSelector;
