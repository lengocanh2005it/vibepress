import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

const SharedLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const stepItems = [
    { label: 'Page setup', path: '/app/projects' },
    { label: 'Canvas edit', path: '/app/editor' },
    { label: 'AI generate', path: '/app/editor/split-view' },
    { label: 'Visual edit', path: '/app/editor/visual' },
    { label: 'Go live', path: '/app/deploy' },
  ];

  const currentPath = location.pathname;
  const currentStep =
    currentPath.startsWith('/app/deploy') ? 4 :
    currentPath.startsWith('/app/editor/visual') ? 3 :
    currentPath.startsWith('/app/editor/split-view') ? 2 :
    currentPath.startsWith('/app/editor') ? 1 :
    0;

  return (
    <div className="flex flex-col bg-surface text-on-surface font-body antialiased min-h-screen overflow-hidden">
      <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-md border-b border-outline-variant/30 shadow-sm">
        <div className="max-w- mx-auto w-full px-5 py-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="group inline-flex items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-container"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary font-bold">
                XP
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-xl font-bold text-primary font-headline italic">X-press AI</span>
              </span>
            </button>

            <nav className="flex w-full items-center justify-start gap-2 rounded-full border border-outline-variant/40 bg-white/70 p-1 text-sm font-medium text-stone-700 md:w-auto md:justify-end">
              <NavLink
                to="/"
                className={({ isActive }) =>
                  `rounded-full px-3 py-1.5 transition-colors ${isActive ? 'bg-primary text-white shadow-sm' : 'hover:bg-surface-container hover:text-primary'}`
                }
              >
                Home
              </NavLink>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-stone-600 transition-colors hover:bg-surface-container hover:text-primary"
              >
                Hosting
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-stone-600 transition-colors hover:bg-surface-container hover:text-primary"
              >
                Support
              </button>
            </nav>
          </div>
        </div>
        <div className="px-5 pb-4 space-y-3">
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

          <div className="grid grid-cols-6 gap-2 text-[11px] text-[#5c6a5e] font-semibold">
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

