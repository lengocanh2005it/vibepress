import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ProjectSelector from './ProjectSelector';

const Onboarding: React.FC = () => {
  const navigate = useNavigate();
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeSuccess, setStoreSuccess] = useState(false);

  const handleOpenStore = () => {
    if (storeLoading) return;
    setStoreLoading(true);
    setTimeout(() => {
      setStoreLoading(false);
      setStoreSuccess(true);
    }, 1500);
  };

  const handleContinue = () => {
    if (!storeSuccess) return;
    navigate('/app/projects');
  };

  return (
    <div className="flex flex-col w-full pb-24">
      
      {/* Onboarding Section (Full Viewport Height roughly) */}
      <section className="w-full max-w-5xl mx-auto px-8 py-16 flex flex-col justify-center min-h-[calc(100vh-120px)] shrink-0">
        
        {/* Header Area */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="font-headline text-[32px] font-bold text-[#233227] leading-tight mb-3">Welcome to X-press AI</h1>
            <p className="text-[#5c6860] text-[15px] font-medium max-w-lg">
              Let's get your development environment ready. Follow the steps to integrate the X-press AI engine into your WordPress site.
            </p>
          </div>
          <div className="text-[#49704F] text-xs font-bold tracking-widest uppercase">
            Step 1 of 5
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-12">
          <div className="w-full flex gap-1 mb-3">
            <div className="h-1.5 flex-1 bg-[#49704F] rounded-full"></div>
            <div className="h-1.5 flex-1 bg-[#e8e6df] rounded-full"></div>
            <div className="h-1.5 flex-1 bg-[#e8e6df] rounded-full"></div>
            <div className="h-1.5 flex-1 bg-[#e8e6df] rounded-full"></div>
            <div className="h-1.5 flex-1 bg-[#e8e6df] rounded-full"></div>
          </div>
          <div className="flex justify-between text-[11px] font-bold tracking-wider text-[#8e9892] uppercase">
            <span className="text-[#49704F]">Installation</span>
            <span>Canvas edit</span>
            <span>AI Generate</span>
            <span>Preview & edit</span>
            <span>Launch</span>
          </div>
        </div>

        {/* Main Options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          
          {/* Option 1: Store Install */}
          <div className="bg-white border border-[#e8e6df] rounded-3xl p-8 shadow-sm relative hover:shadow-md transition-shadow">
            <div className="absolute top-8 right-8 bg-[#e8d5a1] text-[#7a5e18] text-[11px] font-bold px-3 py-1 rounded-full">
              Recommended
            </div>
            <div className="w-12 h-12 bg-[#FAF7F0] rounded-full flex items-center justify-center text-[#49704F] mb-6">
              <span className="material-symbols-outlined text-[20px]">shopping_cart</span>
            </div>
            <h3 className="font-headline text-2xl font-bold text-[#1a2b21] mb-4">Install via WordPress<br/>Store</h3>
            <p className="text-[#5c6860] text-[15px] leading-relaxed mb-6">
              The easiest way to keep X-press AI updated. Search for <span className="font-bold text-[#49704F]">'X-press Vibecode'</span> in your WordPress Plugins menu.
            </p>
            
            <div className="bg-[#FAF7F0] rounded-2xl p-4 flex items-center justify-between border border-[#e8e6df]">
              <div className="flex items-center gap-4">
                <div className="font-headline text-2xl font-bold text-[#49704F] italic pr-2 border-r border-[#e8e6df]">W</div>
                <div>
                  <h4 className="text-[13px] font-bold text-[#233227]">X-press Vibecode</h4>
                  <p className="text-[12px] text-[#8e9892]">Version 2.4.0 • 50k+ installs</p>
                </div>
              </div>
              <button
                onClick={handleOpenStore}
                className={`text-white text-[13px] font-bold px-4 py-2 rounded-xl transition-colors ${storeSuccess ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-[#49704F] hover:bg-[#346E56]'}`}
                disabled={storeLoading}
              >
                {storeLoading ? 'Connecting...' : storeSuccess ? 'Connected to WordPress' : 'Open Store'}
              </button>
            </div>
          </div>

          {/* Option 2: ZIP Install */}
          <div className="bg-[#FAF7F0] border-2 border-dashed border-[#dcd9ce] rounded-3xl p-8 flex flex-col items-center justify-center text-center relative group">
            <div className="w-14 h-14 bg-[#e8e6df] group-hover:bg-[#dcd9ce] transition-colors rounded-full flex items-center justify-center text-[#49704F] mb-6">
              <span className="material-symbols-outlined text-[24px]">cloud_upload</span>
            </div>
            <h3 className="font-headline text-2xl font-bold text-[#1a2b21] mb-3">Download Plugin ZIP</h3>
            <p className="text-[#5c6860] text-[15px] leading-relaxed max-w-sm mb-6">
              Already have the package? Drag and drop your <code className="bg-[#e8e6df] text-[#233227] px-1.5 py-0.5 rounded text-sm">x-press-vibe.zip</code> file here to start the manual installation.
            </p>
            <a
              onClick={() => setStoreSuccess(true)}
              href="/vibepress-db-info.zip"
              download="vibepress-db-info.zip"
              className="bg-white border border-[#dcd9ce] text-[#233227] text-[14px] font-bold px-8 py-3 rounded-full hover:bg-[#FAF7F0] shadow-sm transition-all mb-4 inline-flex"
            >
              Download Files
            </a>
            <p className="text-[12px] text-[#8e9892]">File size: 7.8 KB</p>
          </div>

        </div>

        {/* Security Info */}
        <div className="bg-[#f0eede] border border-[#e6e2cd] rounded-2xl p-6 flex gap-4 items-start mb-12">
          <div className="w-6 h-6 rounded-full bg-[#8c8874] text-white flex items-center justify-center shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-[14px] font-bold">info</span>
          </div>
          <div>
            <h4 className="text-[15px] font-bold text-[#233227] mb-1">Installation Security</h4>
            <p className="text-[14px] text-[#5c6860] leading-relaxed">
              Both installation methods are cryptographically signed and secured. X-press AI ensures your core WordPress files remain untouched while providing deep integration through the Vibecode API.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center w-full">
          <button className="flex items-center gap-2 text-[14px] font-bold text-[#5c6860] hover:text-[#233227] transition-colors" onClick={() => navigate('/app/projects')}>
            <span className="material-symbols-outlined text-[18px]">home</span> Go to Home
          </button>
          <button 
             onClick={handleContinue}
            className={`flex items-center gap-2 px-6 py-3 rounded-full font-bold transition-all shadow-sm ${storeSuccess ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-[#c7ccc0] text-stone-500 cursor-not-allowed'}`}
            disabled={!storeSuccess}
          >
            Continue <span className="material-symbols-outlined text-[18px]">expand_more</span>
          </button>
        </div>
      </section>

      {/* Transition Separator */}
      <div className="w-full max-w-5xl mx-auto h-px bg-[#dcd9ce] my-12 relative flex justify-center">
        <span className="absolute -top-[14px] bg-[#FAF7F0] px-6 text-[#8e9892] text-[11px] uppercase font-bold tracking-widest border border-[#dcd9ce] rounded-full py-1">Or manage existing hosted sources</span>
      </div>

      {/* Source Host / Project Management Section */}
      <section id="projects-section" className="w-full">
        <ProjectSelector />
      </section>

    </div>
  );
};

export default Onboarding;
