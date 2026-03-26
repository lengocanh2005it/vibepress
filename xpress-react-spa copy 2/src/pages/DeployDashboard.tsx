import React, { useState } from 'react';

const DeployDashboard: React.FC = () => {
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);

  const handleSyncToWp = () => {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      setSynced(true);
      setTimeout(() => setSynced(false), 5000); // Hide notification after 5s
    }, 2500);
  };

  return (
    <div className="flex-1 overflow-y-auto p-12 bg-surface">
      {/* Notification Alert */}
      {synced && (
        <div className="mb-8 flex items-center justify-between p-4 bg-primary-fixed border border-primary-container rounded-xl shadow-lg animate-fade-in z-50">
          <div className="flex items-center gap-3 text-on-primary-fixed-variant">
            <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>sync_saved_locally</span>
            <p className="font-body text-sm font-medium">Success: Sync to WordPress completed successfully. 14 items updated in Database and Assets mapped to Active Theme.</p>
          </div>
          <button onClick={() => setSynced(false)} className="text-on-primary-fixed-variant hover:opacity-70">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      {/* Top Section: Deployment Actions */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-10 max-w-7xl mx-auto">
        <div className="xl:col-span-2 bg-surface-container-low p-8 rounded-2xl border border-outline-variant/30 shadow-sm">
          <h2 className="text-2xl font-headline font-bold mb-6 text-on-surface">Deployment & Sync</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Sync to WP Button */}
            <button 
              onClick={handleSyncToWp} 
              disabled={syncing}
              className={`flex flex-col items-start p-6 rounded-xl border transition-all active:scale-[0.98] ${syncing ? 'bg-surface-container-highest border-outline-variant cursor-wait' : 'bg-surface-container-highest border-outline-variant hover:border-primary group'}`}
            >
              <div className={`p-3 rounded-lg mb-4 flex items-center gap-3 ${syncing ? 'bg-primary/20 text-primary' : 'bg-surface-container-low text-primary'}`}>
                <span className={`material-symbols-outlined text-2xl ${syncing ? 'animate-spin' : ''}`}>sync</span>
                {syncing && <span className="font-bold text-sm tracking-widest">SYNCING...</span>}
              </div>
              <span className="font-headline text-xl font-bold text-on-surface">Sync to WordPress</span>
              <p className="text-sm text-on-surface-variant mt-2 text-left leading-relaxed">Đồng bộ mã nguồn React vừa tạo ngược về giao diện và Database trên host WP (Public Mode).</p>
            </button>
            
            {/* Deploy to Edge */}
            <button className="flex flex-col items-start p-6 bg-primary text-white rounded-xl border border-transparent shadow-lg hover:shadow-xl hover:shadow-primary/20 transition-all active:scale-[0.98] group">
              <div className="p-3 bg-primary-container rounded-lg mb-4 text-on-primary-container group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined text-2xl">rocket_launch</span>
              </div>
              <span className="font-headline text-xl font-bold text-on-primary">Deploy to X-press Cloud</span>
              <p className="text-sm text-on-primary-container mt-2 text-left leading-relaxed">Tách hẳn khỏi Wordpress, sử dụng domain của X-press platform với cơ sở dữ liệu độc lập (Host Mode).</p>
            </button>
          </div>
        </div>

        {/* Domain Settings */}
        <div className="bg-surface-container-low p-8 rounded-2xl border border-outline-variant/30 shadow-sm">
          <h2 className="text-xl font-headline font-bold mb-6 text-on-surface">Environment Setup</h2>
          <div className="space-y-4">
            <div className="p-4 bg-white rounded-xl border border-outline-variant/50 shadow-sm hover:border-primary/50 transition-colors">
              <label className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Primary Domain</label>
              <div className="flex items-center justify-between mt-2">
                <span className="font-body text-base font-bold text-on-surface">terra-organic.xpress.ai</span>
                <span className="px-2 py-1 bg-emerald-100 text-emerald-800 text-[10px] font-extrabold rounded">ACTIVE</span>
              </div>
            </div>
            <div className="p-4 bg-transparent rounded-xl border-2 border-dashed border-outline-variant/50 flex flex-col items-center justify-center cursor-pointer hover:bg-white hover:border-primary/50 transition-all text-on-surface-variant hover:text-primary group py-8">
              <span className="material-symbols-outlined text-3xl mb-2 group-hover:scale-110 transition-transform">add_circle</span>
              <span className="font-label text-sm font-bold">Connect Custom Domain</span>
            </div>
          </div>
        </div>
      </section>

      {/* Metrics Dashboard */}
      <section className="max-w-7xl mx-auto border-t border-outline-variant/30 pt-10">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-headline font-bold text-on-surface">Daily CMS Dashboard</h2>
          <select className="bg-white border border-outline-variant/50 text-sm font-bold rounded-lg px-4 py-2 text-on-surface shadow-sm outline-none focus:ring-2 focus:ring-primary/50">
            <option>Last 7 Days</option>
            <option>This Month</option>
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Quick Stats */}
          <div className="bg-tertiary-container p-6 rounded-2xl flex flex-col justify-between overflow-hidden relative shadow-sm border border-tertiary-container hover:shadow-lg transition-shadow">
            <div className="relative z-10">
              <h3 className="text-sm font-label font-bold tracking-widest uppercase text-on-tertiary-container/80">Conversion Rate</h3>
              <p className="text-5xl font-bold mt-2 text-on-tertiary-container">4.2%</p>
              <div className="mt-4 flex items-center gap-1 bg-white/20 w-max px-3 py-1 rounded-full text-on-tertiary-container font-extrabold text-xs">
                <span className="material-symbols-outlined text-sm">trending_up</span>
                <span>+12.4%</span>
              </div>
            </div>
            <div className="absolute -right-6 -bottom-6 opacity-10">
              <span className="material-symbols-outlined text-9xl">monitoring</span>
            </div>
          </div>

          <div className="bg-primary-container p-6 rounded-2xl flex flex-col justify-between overflow-hidden relative shadow-sm border border-primary-container hover:shadow-lg transition-shadow">
            <div className="relative z-10">
              <h3 className="text-sm font-label font-bold tracking-widest uppercase text-on-primary-container/80">Page Views</h3>
              <p className="text-5xl font-bold mt-2 text-on-primary-container">12.8k</p>
              <div className="mt-4 flex items-center gap-1 bg-white/20 w-max px-3 py-1 rounded-full text-on-primary-container font-extrabold text-xs">
                <span className="material-symbols-outlined text-sm">trending_up</span>
                <span>+3.1%</span>
              </div>
            </div>
            <div className="absolute -right-6 -bottom-6 opacity-10">
              <span className="material-symbols-outlined text-9xl">visibility</span>
            </div>
          </div>

          <div className="bg-error-container p-6 rounded-2xl flex flex-col justify-between overflow-hidden relative shadow-sm border border-error-container hover:shadow-lg transition-shadow">
            <div className="relative z-10">
              <h3 className="text-sm font-label font-bold tracking-widest uppercase text-on-error-container/80">Bounce Rate</h3>
              <p className="text-5xl font-bold mt-2 text-on-error-container">21%</p>
              <div className="mt-4 flex items-center gap-1 bg-white/20 w-max px-3 py-1 rounded-full text-on-error-container font-extrabold text-xs">
                <span className="material-symbols-outlined text-sm">trending_down</span>
                <span>-5.2%</span>
              </div>
            </div>
            <div className="absolute -right-6 -bottom-6 opacity-10">
              <span className="material-symbols-outlined text-9xl">speed</span>
            </div>
          </div>

          {/* Setup Notice Block */}
          <div className="bg-surface-container p-6 rounded-2xl border border-outline-variant/30 shadow-inner flex flex-col justify-center gap-3 relative overflow-hidden group">
            <div className="w-12 h-12 bg-white rounded-xl shadow-sm flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-2xl">sell</span>
            </div>
            <h3 className="font-bold text-on-surface text-lg">Manage Products directly on X-press</h3>
            <p className="text-sm text-on-surface-variant">Update inventory without touching WP Admin.</p>
            <button className="mt-2 text-primary font-bold text-sm w-max flex items-center gap-1 hover:gap-2 transition-all">
              Go to Store <span className="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default DeployDashboard;
