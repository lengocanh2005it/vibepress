import { Outlet, useLocation } from 'react-router-dom';
import TopNav from './TopNav';

const SharedLayout = () => {
  const location = useLocation();

  const stepItems = [
    { label: 'Page setup', path: '/app/projects' },
    { label: 'Canvas edit', path: '/app/editor' },
    { label: 'AI generate', path: '/app/editor/split-view' },
    { label: 'Visual edit', path: '/app/editor/visual' },
  ];

  const currentPath = location.pathname;
  const currentStep =
    currentPath.startsWith('/app/editor/visual') ? 3 :
    currentPath.startsWith('/app/editor/split-view') ? 2 :
    currentPath.startsWith('/app/editor') ? 1 :
    0;

  return (
    <div className="flex flex-col bg-surface text-on-surface font-body antialiased min-h-screen overflow-hidden">
      <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-md border-b border-outline-variant/30 shadow-sm">
        <TopNav />
        <div className="px-5 pb-4 space-y-3 mt-20">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-[#4a6d4e]">Progress</h3>
            <span className="text-xs font-semibold text-[#4b7a5b]">Step {currentStep + 1} of {stepItems.length}</span>
          </div>

          <div className="w-full h-3 rounded-full bg-[#e8e6df] overflow-hidden border border-[#d7dbd6]">
            <div
              className="h-full bg-gradient-to-r from-[#49704F] via-[#82B794] to-[#C8E8C2] transition-all duration-500"
              style={{ width: `${((currentStep + 1) / stepItems.length) * 100}%` }}
            />
          </div>

          <div className="grid grid-cols-4 gap-2 text-[11px] text-[#5c6a5e] font-semibold">
              {stepItems.map((step, idx) => (
                <button
                  key={step.label}
                  className={`rounded-full py-1 ${idx === currentStep ? 'text-[#2f5a45] bg-[#d8f0e2]' : 'text-[#7f8e83] bg-white hover:bg-[#f2f7f0]'}`}
                  disabled={idx > currentStep + 1}
                >
                  {step.label}
                </button>
              ))}
          </div>
          </div>
      </header>

      <main className="flex-1 pt-4 w-full min-h-[calc(100vh-76px)]">
        <Outlet />
      </main>
    </div>
  );
};

export default SharedLayout;

