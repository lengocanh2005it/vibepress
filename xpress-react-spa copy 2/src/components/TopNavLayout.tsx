import { Outlet } from 'react-router-dom';

const TopNavLayout = () => {
  return (
    <div className="flex flex-col bg-[#F8F6F1] text-stone-800 font-body antialiased min-h-screen relative">
      <header className="w-full flex justify-between items-center px-8 py-5 relative z-50">
        <div className="flex items-center gap-16">
          <span className="text-[22px] font-bold text-[#355A44] font-headline italic tracking-tight">X-press AI</span>
          <nav className="hidden lg:flex items-center gap-8">
            <a href="#" className="text-stone-600 hover:text-stone-900 transition-colors text-sm font-medium">Projects</a>
            <a href="#" className="text-stone-900 border-b-2 border-stone-900 pb-1 font-semibold text-sm">Cloud</a>
            <a href="#" className="text-stone-600 hover:text-stone-900 transition-colors text-sm font-medium">Analytics</a>
            <a href="#" className="text-stone-600 hover:text-stone-900 transition-colors text-sm font-medium">Support</a>
          </nav>
        </div>
        <div className="flex items-center gap-5">
          <button className="text-stone-600 hover:text-stone-900 transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>notifications</span>
          </button>
          <button className="text-stone-600 hover:text-stone-900 transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </button>
          <div className="w-8 h-8 rounded-full overflow-hidden bg-stone-300 cursor-pointer">
            <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNquCMiRaqjW9ZQps-IM_DXabuGUWa5xfomwd9zlIJn7NyMhcGfdKCYFCtJWfNM1zH94ZA4ylfu9E-NpBJ6cnjgIkQeyNlppuzfxcoKXDCLkNr55QMG2hN8o0i3stD84tWxv6CPjOhxCNCTCpPsHyu72rwl4y45POvfYHIrx9kfwbLravt0JpmIMr-Ky4PNBEde_d--vaoYEWCtz1ZmUP_56qT9wRvWbKM2YYGPa91v99RPbXvS8dHLGGD4jlB2yNgdM7SXTCISW8" className="w-full h-full object-cover" alt="User profile" />
          </div>
        </div>
      </header>

      {/* Dynamic Content */}
      <main className="flex-1 flex flex-col pt-4">
        <Outlet />
      </main>
    </div>
  );
};

export default TopNavLayout;
