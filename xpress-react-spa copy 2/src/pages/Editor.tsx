import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Annotation {
  id: number;
  targetId: string;
  author: string;
  time: string;
  content: string;
  initials: string;
  colorClasses: string;
}

const Editor: React.FC = () => {
  const navigate = useNavigate();
  const [annotationsOpen, setAnnotationsOpen] = useState(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        navigate('/app/editor/split-view');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
  
  const [chatInput, setChatInput] = useState('');

  const sendChatMessage = () => {
    if (!chatInput.trim()) return;
    setChatInput('');
    navigate('/app/editor/split-view');
  };

  const [annotations, setAnnotations] = useState<Annotation[]>([
    {
      id: 1,
      targetId: 'block-1',
      author: 'John Doe',
      time: '10 minutes ago',
      content: 'Make this header sticky so it follows the user down the page. Also increase the top padding slightly.',
      initials: 'JD',
      colorClasses: 'bg-[#d2dacb] text-[#49704F]'
    },
    {
      id: 2,
      targetId: 'block-2',
      author: 'Sarah Miller',
      time: '2 hours ago',
      content: 'Adjust font-weight of the subheaders. They feel a bit too thin compared to the primary headline.',
      initials: 'SM',
      colorClasses: 'bg-[#e8d5a1]/40 text-[#7a5e18]'
    },
    {
      id: 3,
      targetId: 'block-3',
      author: 'Alex Kim',
      time: 'Yesterday',
      content: 'Should we add a newsletter signup widget here? It\'s a key conversion point for the client.',
      initials: 'AK',
      colorClasses: 'bg-[#f0eede] text-[#8e9892]'
    }
  ]);

  const [hoveredBlock, setHoveredBlock] = useState<string | null>(null);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');

  const handleAddComment = () => {
    if (!commentText.trim() || !activeTarget) return;
    const newId = annotations.length > 0 ? Math.max(...annotations.map(a => a.id)) + 1 : 1;
    const newAnnotation: Annotation = {
      id: newId,
      targetId: activeTarget,
      author: 'Current User',
      time: 'Just now',
      content: commentText.trim(),
      initials: 'CU',
      colorClasses: 'bg-[#49704F] text-white'
    };
    setAnnotations([...annotations, newAnnotation]);
    setCommentText('');
    setActiveTarget(null);
  };

  const BlockWrapper = ({ id, children, className = "" }: { id: string, children: React.ReactNode, className?: string }) => {
    const isHovered = hoveredBlock === id;
    const isActive = activeTarget === id;
    const blockAnnotations = annotations.filter(a => a.targetId === id);

    return (
      <div 
        className={`relative cursor-pointer transition-all duration-200 ${isHovered || isActive ? 'ring-2 ring-[#49704F] ring-offset-4 ring-offset-[#e8e6df]/50 rounded-3xl scale-[1.01]' : ''} ${className}`}
        onMouseEnter={() => setHoveredBlock(id)}
        onMouseLeave={() => setHoveredBlock(null)}
        onClick={() => {
          setActiveTarget(id);
          setAnnotationsOpen(true);
        }}
      >
        {blockAnnotations.map((ann, idx) => (
          <div key={ann.id} className="absolute -left-4 -top-4 w-8 h-8 rounded-full border-[3px] border-white bg-[#49704F] text-white flex items-center justify-center font-bold text-[14px] shadow-md z-30 transition-transform hover:scale-110" style={{ transform: `translateY(${idx * 40}px)` }}>
            {ann.id}
          </div>
        ))}
        {(isHovered && blockAnnotations.length === 0 && !isActive) && (
           <div className="absolute -left-4 -top-4 w-8 h-8 rounded-full border-[3px] border-dashed border-[#49704F] bg-white text-[#49704F] flex items-center justify-center font-bold text-[18px] shadow-sm z-30">
             +
           </div>
        )}
        {children}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-[#FAF7F0] font-body text-[#233227] overflow-hidden">
      
      {/* Top Navbar */}
      <header className="h-[72px] shrink-0 border-b border-[#e8e6df] px-6 flex items-center justify-between bg-[#FAF7F0] z-20">
        <div className="flex items-center gap-2">
          <span className="font-headline text-[22px] font-bold text-[#49704F] tracking-tight">TerraWP</span>
        </div>
        
        <div className="flex-1 flex justify-center max-w-2xl px-8">
          <div className="relative w-full max-w-md">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#8e9892] text-[18px]">search</span>
            <input 
              type="text" 
              placeholder="Search pages..." 
              className="w-full bg-[#e8e6df]/60 border-none rounded-full pl-11 pr-4 py-2.5 text-[14px] focus:ring-2 focus:ring-[#49704F]/30 outline-none placeholder:text-[#8e9892]"
            />
          </div>
        </div>

        <div className="flex items-center gap-5">
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors"><span className="material-symbols-outlined text-[20px]">help</span></button>
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors"><span className="material-symbols-outlined text-[20px]">notifications</span></button>
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors"><span className="material-symbols-outlined text-[20px]">settings</span></button>
          <div className="w-8 h-8 rounded-full overflow-hidden bg-stone-300 border border-[#e8e6df]">
            <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNquCMiRaqjW9ZQps-IM_DXabuGUWa5xfomwd9zlIJn7NyMhcGfdKCYFCtJWfNM1zH94ZA4ylfu9E-NpBJ6cnjgIkQeyNlppuzfxcoKXDCLkNr55QMG2hN8o0i3stD84tWxv6CPjOhxCNCTCpPsHyu72rwl4y45POvfYHIrx9kfwbLravt0JpmIMr-Ky4PNBEde_d--vaoYEWCtz1ZmUP_56qT9wRvWbKM2YYGPa91v99RPbXvS8dHLGGD4jlB2yNgdM7SXTCISW8" className="w-full h-full object-cover" alt="User profile" />
          </div>
        </div>
      </header>

      {/* Main Work Area */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Sidebar: Site Pages */}
        <aside className="w-64 shrink-0 bg-[#FAF7F0] border-r border-[#e8e6df] flex flex-col z-10">
          <div className="p-6">
            <h2 className="font-headline text-[20px] font-bold text-[#1a2b21] mb-1">Site Pages</h2>
            <p className="text-[#5c6860] text-[13px]">Select a page to edit layout.</p>
          </div>
          
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
            {/* Active Page */}
            <div className="bg-[#FAF7F0] border-2 border-[#49704F] rounded-2xl p-4 flex flex-col gap-2 relative shadow-sm cursor-pointer">
              <div className="absolute top-4 right-4 bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">Editing</div>
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-[#49704F] text-[18px]">home</span>
                <span className="font-bold text-[#233227] text-[14px]">Home</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                <span className="material-symbols-outlined text-[13px]">history</span>
                Saved 2m ago
              </div>
            </div>

            {/* Inactive Pages */}
            {['Blog', 'About Us', 'Services', 'Contact'].map((page, idx) => (
              <div key={idx} className="bg-white border border-[#e8e6df] rounded-2xl p-4 flex flex-col gap-2 hover:border-[#dcd9ce] transition-colors cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-[#8e9892] text-[18px]">
                    {page === 'Blog' ? 'article' : page === 'About Us' ? 'info' : page === 'Services' ? 'build' : 'mail'}
                  </span>
                  <span className="font-bold text-[#233227] text-[14px]">{page}</span>
                </div>
                {page === 'Blog' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                    <span className="material-symbols-outlined text-[13px]">history</span> Updated 5h ago
                  </div>
                )}
              </div>
            ))}

            <button className="w-full mt-4 bg-transparent border-2 border-dashed border-[#dcd9ce] rounded-full py-3 flex items-center justify-center gap-2 text-[#233227] font-bold text-[13px] hover:bg-[#e8e6df]/30 transition-colors">
              <span className="material-symbols-outlined text-[18px]">add_circle</span> Add new page
            </button>
          </div>
        </aside>

        {/* Center Canvas */}
        <main className="flex-1 bg-[#e8e6df]/50 relative flex justify-center overflow-hidden">
          
          <div className="absolute top-6 right-6 z-20">
            <button 
              onClick={() => setAnnotationsOpen(!annotationsOpen)}
              className="bg-[#49704F] text-white text-[13px] font-bold px-4 py-2 rounded-full shadow-md flex items-center gap-2 hover:bg-[#346E56] transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">visibility</span> Live Preview
            </button>
          </div>

          <div className="w-full max-w-4xl h-full overflow-y-auto pt-16 pb-32 px-12 relative remove-scrollbar" onClick={() => setActiveTarget(null)}>
            
            {/* Outline wireframes */}
            <div className="space-y-6" onClick={e => e.stopPropagation()}>

              {/* Block 1 */}
              <BlockWrapper id="block-1">
                <div className="bg-[#FAF7F0] border border-[#e8e6df] rounded-3xl p-6 shadow-sm pointer-events-none">
                  <div className="flex justify-between items-center mb-6">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]"></div>
                      <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]"></div>
                      <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f]"></div>
                    </div>
                    <span className="font-mono text-[#8e9892] text-[11px]">&lt;?php wp_head(); ?&gt;</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-4 w-32 bg-[#e8e6df] rounded-full"></div>
                    <div className="h-4 w-20 bg-[#e8e6df] rounded-full"></div>
                    <div className="h-px bg-[#e8e6df] flex-1 mx-4"></div>
                    <div className="w-8 h-8 rounded-full bg-[#e8e6df]"></div>
                  </div>
                  <div className="h-3 w-3/4 bg-[#e8e6df] rounded-full mt-6"></div>
                </div>
              </BlockWrapper>

              {/* Block 2 & 3 row */}
              <div className="flex gap-6 relative">
                <BlockWrapper id="block-2" className="flex-1">
                  <div className="bg-[#FAF7F0] border border-[#e8e6df] rounded-3xl p-8 flex flex-col gap-6 shadow-sm h-full pointer-events-none">
                    <div className="h-6 w-1/3 bg-[#d2dacb] rounded-full"></div>
                    <div className="space-y-3">
                      <div className="h-3 w-full bg-[#e8e6df] rounded-full"></div>
                      <div className="h-3 w-5/6 bg-[#e8e6df] rounded-full"></div>
                      <div className="h-3 w-2/3 bg-[#e8e6df] rounded-full mt-4"></div>
                    </div>
                  </div>
                </BlockWrapper>

                <BlockWrapper id="block-3" className="w-1/3">
                  <div className="bg-[#FAF7F0] border border-[#e8e6df] rounded-3xl p-6 flex flex-col shadow-sm relative h-full pointer-events-none">
                    <div className="h-24 bg-[#e8e6df] rounded-xl w-full mb-4 opacity-50"></div>
                    <div className="h-3 w-full bg-[#e8e6df] rounded-full mt-auto"></div>
                  </div>
                </BlockWrapper>
              </div>

              {/* Block 4 */}
              <BlockWrapper id="block-4">
                <div className="bg-[#FAF7F0] border border-[#e8e6df] rounded-3xl p-8 shadow-sm pointer-events-none">
                  <div className="bg-[#e8e6df]/50 rounded-2xl h-64 mb-6 relative overflow-hidden flex items-center justify-center">
                    <svg className="w-48 h-48 text-[#d2dacb] absolute" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                      <path fill="currentColor" d="M44.7,-76.4C58.9,-69.2,71.8,-59.1,81.1,-46.3C90.4,-33.5,96.1,-18.1,95.4,-3.2C94.7,11.7,87.6,26.1,76.5,36.5C65.4,46.9,50.3,53.3,36.6,60.9C22.9,68.5,10.6,77.3,-2.8,81.9C-16.2,86.5,-30.7,86.9,-43.3,80.5C-55.9,74.1,-66.6,60.9,-75.4,46.6C-84.2,32.3,-91.1,16.9,-91,-0.1C-90.9,-17.1,-83.8,-33.4,-72,-44.6C-60.2,-55.8,-43.7,-61.9,-29.7,-69.5C-15.7,-77.1,-4.2,-86.2,6.5,-84.8C17.2,-83.4,30.5,-83.6,44.7,-76.4Z" transform="translate(100 100) scale(1.1)" />
                    </svg>
                    <svg className="w-24 h-24 text-[#8e9892] absolute bottom-4 left-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" /></svg>
                  </div>
                  <div className="h-5 w-48 bg-[#d2dacb] rounded-full mb-3"></div>
                  <div className="h-3 w-full bg-[#e8e6df] rounded-full mb-2"></div>
                  <div className="h-3 w-5/6 bg-[#e8e6df] rounded-full mb-6"></div>
                  <div className="h-4 w-32 bg-[#e8e6df] rounded-full"></div>
                </div>
              </BlockWrapper>

            </div>
          </div>

          {/* Floating AI Prompt Bar */}
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-40 flex flex-col items-center pointer-events-none">
            
            <div className="flex flex-wrap justify-center gap-2 mb-3 pointer-events-auto">
              <button className="bg-white border border-[#49704F]/20 text-[#233227] text-[12px] font-bold px-4 py-1.5 rounded-full shadow-sm hover:border-[#49704F] transition-colors">Refactor Header</button>
              <button className="bg-white border border-[#49704F]/20 text-[#233227] text-[12px] font-bold px-4 py-1.5 rounded-full shadow-sm hover:border-[#49704F] transition-colors">Optimize SEO</button>
              <button className="bg-white border border-[#49704F]/20 text-[#233227] text-[12px] font-bold px-4 py-1.5 rounded-full shadow-sm hover:border-[#49704F] transition-colors">Translate to VN</button>
              <button className="bg-white border border-[#49704F]/20 text-[#233227] text-[12px] font-bold px-4 py-1.5 rounded-full shadow-sm hover:border-[#49704F] transition-colors">Check Dependencies</button>
            </div>

            <div className="w-full bg-[#FAF7F0] border border-[#e8e6df] rounded-full p-2 pl-4 pr-2 flex items-center shadow-lg shadow-[#49704F]/10 pointer-events-auto">
              <span className="material-symbols-outlined text-[#49704F] mr-3">auto_awesome</span>
              <input 
                type="text" 
                placeholder="Ask AI to refactor, translate or optimize your WordPress code..." 
                className="flex-1 bg-transparent border-none text-[14px] outline-none text-[#233227] placeholder:text-[#8e9892]"
              />
              <div className="flex items-center gap-3 px-3 border-l border-[#e8e6df] ml-2">
                <span className="text-[11px] font-bold text-[#233227] tracking-wider">EN | <span className="text-[#8e9892]">VN</span></span>
              </div>
              <button className="w-10 h-10 bg-[#49704F] rounded-full flex items-center justify-center text-white hover:bg-[#346E56] transition-colors shadow-sm">
                <span className="material-symbols-outlined text-[18px]">send</span>
              </button>
            </div>
          </div>

        </main>

        {/* Right Sidebar: Annotations only */}
        {annotationsOpen && (
          <aside className="w-80 shrink-0 bg-[#FAF7F0] border-l border-[#e8e6df] flex flex-col z-10 transition-all duration-300">
            <div className="p-6 pb-4 border-b border-[#e8e6df]">
              <div className="flex justify-between items-center mb-1">
                <h2 className="font-headline text-[18px] font-bold text-[#1a2b21]">Annotations</h2>
                <span className="bg-[#e8d5a1] bg-opacity-40 text-[#7a5e18] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full border border-[#dcd9ce]">{annotations.length} Open</span>
              </div>
              <p className="text-[#5c6860] text-[13px]">Feedback from <span className="font-bold text-[#233227]">stakeholders</span>.</p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {activeTarget && (
                <div className="bg-white border border-[#49704F]/50 ring-2 ring-[#49704F]/20 rounded-2xl p-4 shadow-sm relative z-20 mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="material-symbols-outlined text-[#49704F] text-[16px]">add_comment</span>
                    <span className="text-[12px] font-bold text-[#49704F]">Comment on {activeTarget.replace('-', ' ')}</span>
                  </div>
                  <textarea 
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="Type your feedback here..."
                    className="w-full bg-[#FAF7F0] border border-[#e8e6df] rounded-lg p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button 
                      onClick={() => { setActiveTarget(null); setCommentText(''); }}
                      className="text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#e8e6df]/50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleAddComment}
                      disabled={!commentText.trim()}
                      className="bg-[#49704F] disabled:opacity-50 text-white text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#346E56] transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}

              {annotations.map(ann => (
                <div key={ann.id} className="relative group">
                  <div className="absolute -left-2 top-0 w-6 h-6 rounded-full border-2 border-white bg-[#49704F] text-white flex items-center justify-center font-bold text-[10px] z-10">{ann.id}</div>
                  <div className={`bg-white border rounded-2xl p-5 ml-2 shadow-sm transition-colors ${activeTarget === ann.targetId ? 'border-[#49704F] ring-1 ring-[#49704F]' : 'border-[#e8e6df]'}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-8 h-8 rounded-full ${ann.colorClasses} flex items-center justify-center text-[11px] font-bold`}>{ann.initials}</div>
                      <div className="leading-tight">
                        <p className="text-[13px] font-bold text-[#233227]">{ann.author}</p>
                        <p className="text-[10px] text-[#8e9892]">{ann.time}</p>
                      </div>
                    </div>
                    <p className="text-[13px] text-[#5c6860] leading-relaxed mb-4">"{ann.content}"</p>
                    <div className="flex gap-2">
                      <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce] transition-colors">Reply</button>
                      <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce] transition-colors">Resolve</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 border-t border-[#e8e6df]">
              <button 
                onClick={() => {
                  if (!activeTarget) setActiveTarget('block-1');
                }}
                className="w-full bg-[#49704F] text-white text-[13px] font-bold py-3 rounded-full flex items-center justify-center gap-2 hover:bg-[#346E56] transition-colors shadow-sm"
              >
                <span className="material-symbols-outlined text-[16px]">add_comment</span> New Annotation
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* Bottom-centered chat bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[min(100vw-1rem,920px)] bg-white border border-[#d4d8d1] rounded-3xl shadow-xl backdrop-blur-md z-50">
        <div className="p-3 border-b border-[#e5e8df]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <h3 className="font-semibold text-sm text-[#2e3e2f]">Live Chat</h3>
            </div>
            <span className="text-[11px] text-[#7a836f]">AI chat mode</span>
          </div>
          <p className="mt-2 text-[12px] text-[#5e6a5f]">Gợi ý: refactor header, tối ưu SEO, chuyển ngôn ngữ, kiểm tra Dependency</p>
        </div>

        <div className="p-3 flex flex-wrap gap-2">
          {['Refactor Header', 'Optimize SEO', 'Translate to VN', 'Check Dependencies'].map((hint) => (
            <button
              key={hint}
              onClick={() => setChatInput(hint)}
              className="text-[11px] text-[#3f593b] bg-[#eff7ee] border border-[#d8e8d3] px-3 py-1.5 rounded-full hover:bg-[#e0f0df] transition-colors"
            >
              {hint}
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-[#e5e8df] flex gap-2 items-center">
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendChatMessage(); }}
            className="flex-1 h-10 text-sm border border-[#ccd7cc] rounded-full px-4 outline-none focus:ring-2 focus:ring-[#4a7c59]/40"
            placeholder="Nhập câu hỏi AI (enter gửi)..."
          />
          <button onClick={sendChatMessage} className="h-10 w-10 rounded-full bg-primary text-white flex items-center justify-center hover:bg-[#356944] transition-colors">
            <span className="material-symbols-outlined">send</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Editor;

