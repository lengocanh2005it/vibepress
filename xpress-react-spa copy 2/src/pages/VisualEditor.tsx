import React, { useState } from 'react';

// Hover Wrapper Component to simulate Section selection
const EditableWrapper: React.FC<{ children: React.ReactNode, id: string, label: string, onSelect: (id: string, label: string) => void }> = ({ children, id, label, onSelect }) => {
  return (
    <div className="relative group/edit -m-4 p-4 rounded-xl border-2 border-transparent hover:border-primary/40 transition-all cursor-cell">
      <button 
        onClick={(e) => { e.stopPropagation(); onSelect(id, label); }}
        className="absolute -top-3 -right-3 z-20 bg-primary text-white flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold shadow-lg opacity-0 group-hover/edit:opacity-100 transition-opacity transform scale-95 group-hover/edit:scale-100"
      >
        <span className="material-symbols-outlined text-[14px]">edit</span> {label}
      </button>
      {children}
    </div>
  );
};

const VisualEditor: React.FC = () => {
  const [activeElement, setActiveElement] = useState<{id: string, label: string} | null>(null);
  const [prompt, setPrompt] = useState("");

  const handleRunEdit = () => {
    // Mock run logic
    setPrompt("");
    setActiveElement(null);
  };

  return (
    <div className="flex-1 bg-surface-container flex flex-col overflow-hidden relative">
      <div className="px-6 py-3 bg-white border-b border-outline-variant/30 flex justify-between items-center shrink-0 shadow-sm z-10">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-on-surface">Visual Editing Mode</span>
          <span className="text-[10px] text-stone-500 uppercase tracking-wider">Hover over any element to edit</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 bg-primary text-white px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm">
            <span className="material-symbols-outlined text-sm">check_circle</span> Done Editing
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Editor Canvas */}
        <div className={`flex-1 overflow-y-auto p-12 bg-surface transition-all duration-300 ${activeElement ? 'mr-80 blur-[2px] opacity-70 pointer-events-none' : ''}`}>
          
          <div className="bg-white shadow-xl rounded-xl max-w-5xl mx-auto p-12 border border-outline-variant/20 relative">
            <EditableWrapper id="nav" label="Edit Navigation" onSelect={(id, label) => setActiveElement({id, label})}>
              <div className="flex justify-between items-center border-b border-outline-variant/20 pb-6 mb-12">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center text-white">
                        <span className="material-symbols-outlined">eco</span>
                    </div>
                    <h1 className="font-headline text-2xl font-bold text-primary">Terra Organic</h1>
                </div>
                <nav className="flex gap-8 text-sm font-label text-stone-600">
                    <a href="#">Shop</a>
                    <a href="#">Our Story</a>
                    <a href="#">Farms</a>
                    <a href="#">Contact</a>
                </nav>
              </div>
            </EditableWrapper>

            <EditableWrapper id="hero" label="Edit Hero Section" onSelect={(id, label) => setActiveElement({id, label})}>
              <div className="grid grid-cols-2 gap-12 items-center">
                  <div className="space-y-6">
                      <span className="text-tertiary font-label font-bold tracking-widest uppercase text-xs">Est. 2024</span>
                      <h2 className="font-headline text-5xl text-on-surface leading-tight">Rooted in <span className="italic text-primary font-normal">Warmth</span> & Quality</h2>
                      <p className="text-stone-600 leading-relaxed text-lg">Experience the finest organic selections directly from our local forest partners.</p>
                      <div className="flex gap-4">
                          <button className="bg-primary text-white px-8 py-3 rounded-xl font-bold shadow-xl shadow-primary/20">Browse Shop</button>
                      </div>
                  </div>
                  <div className="relative">
                      <div className="aspect-square rounded-full overflow-hidden bg-stone-200 border-8 border-white shadow-2xl rotate-3">
                          <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuCmh53sNF2U0WgRgW6ByXwl6vqmgPwJQtnUPuvM4asATSuOKq62ccWW9Rw6RvpmJ2qFI9DG0dzmjcjRdfswxTWjSc894OLZEO04fxOeHOQ_Hu4LyVOA3JFxR-WZKQ9TAbqD90eR4x4ac8BEt22CEzwZvHSgvlnV6CEXpVAeEmTIKJg4eqOV-ioOMQqFxhRfxytWvmLgKbqla3SvTv6OPLEN0FuuYvG1HIsoSUzT8hsW5X3TcokTALf67CVXOvBV7upCbZyTsamQKN4" alt="Fresh produce" className="w-full h-full object-cover" />
                      </div>
                  </div>
              </div>
            </EditableWrapper>

             {/* Footer Mock */}
            <EditableWrapper id="footer" label="Edit Footer" onSelect={(id, label) => setActiveElement({id, label})}>
              <div className="mt-24 border-t border-outline-variant/30 pt-12 flex justify-between items-center text-stone-500 text-sm">
                <p>© 2026 Terra Organic.</p>
                <div className="flex gap-4">
                  <span>Privacy Policy</span>
                  <span>Terms of Service</span>
                </div>
              </div>
            </EditableWrapper>
          </div>
        </div>
      </div>

      {/* Floating Side Panel for AI Chat targeted at specific component */}
      {activeElement && (
        <div className="absolute top-16 right-0 w-96 h-[calc(100vh-4rem)] bg-surface shadow-2xl border-l border-outline-variant/30 flex flex-col z-50 animate-fade-in">
          <div className="h-14 border-b border-outline-variant/30 flex items-center justify-between px-6 bg-surface-container-lowest">
            <h3 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-lg">auto_fix_high</span> 
              Modifying {activeElement.label}
            </h3>
            <button onClick={() => setActiveElement(null)} className="text-on-surface-variant hover:text-error transition-colors">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
            <div className="bg-primary/10 p-4 rounded-xl text-sm text-primary font-medium border border-primary/20">
              Mô tả thay đổi bạn muốn thực hiện trên khối này. X-press AI sẽ render lại Component tương ứng mà không làm ảnh hưởng phần còn lại của Website.
            </div>

            <textarea 
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full bg-surface border-outline-variant/50 rounded-xl p-4 focus:ring-1 focus:ring-primary min-h-[120px] shadow-inner text-sm" 
              placeholder="Ví dụ: Thêm một button gọi điện thoại kế bên nút Browse Shop, đổi màu button sang cam ấm..."
              autoFocus
            ></textarea>
          </div>

          <div className="p-6 border-t border-outline-variant/30 bg-surface-container-lowest">
            <button 
              onClick={handleRunEdit}
              disabled={!prompt}
              className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${prompt ? 'bg-primary text-white shadow-lg shadow-primary/30' : 'bg-surface-container-highest text-stone-400 cursor-not-allowed'}`}
            >
              <span className="material-symbols-outlined">auto_awesome</span> Cập nhật Component
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisualEditor;
