import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { captureRegion, getWpSitePages } from '../services/automationService';
import { runAiProcess } from '../services/AiService';
import { useUser } from '../context/UserContext';

interface WpPage {
  id: number;
  title: string;
  slug: string;
  link: string;
  status: string;
}

interface Capture {
  id: string;
  filePath: string;
  comment: string;
  pageUrl: string;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

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
  const location = useLocation();
  const siteUrl: string = location.state?.siteUrl || '';
  const siteId: string = location.state?.siteId || '';
  const {email} = useUser();

  const [annotationsOpen, setAnnotationsOpen] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [wpPages, setWpPages] = useState<WpPage[]>([]);
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>(siteUrl);

  // Capture states
  const [isCapturing, setIsCapturing] = useState(false);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [captureComment, setCaptureComment] = useState('');
  const [showCommentPopup, setShowCommentPopup] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [isSubmittingCapture, setIsSubmittingCapture] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatTags, setChatTags] = useState<string[]>(['Refactor Header', 'Optimize SEO', 'Translate to VN', 'Check Dependencies']);
  const overlayRef = useRef<HTMLDivElement>(null);

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
      content: "Should we add a newsletter signup widget here? It's a key conversion point for the client.",
      initials: 'AK',
      colorClasses: 'bg-[#f0eede] text-[#8e9892]'
    }
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        navigate('/app/editor/split-view', { state: { siteId } });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, siteId]);

  useEffect(() => {
    if (!siteUrl) return;
    getWpSitePages(siteUrl)
      .then(setWpPages)
      .catch(() => setWpPages([]));
  }, [siteUrl]);

  const sendChatMessage = () => {
    if (!chatInput.trim()) return;
    
    setChatInput('');
    if(siteId)
    {
      runAiProcess(siteId).then((data)=>{
        console.log('AI process started with job ID:', data.jobId);
        navigate('/app/editor/split-view', { state: { jobId: data.jobId, siteId } });
      })
    }
  };

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

  const getRelativeRect = (sel: SelectionRect) => ({
    x: Math.min(sel.startX, sel.endX),
    y: Math.min(sel.startY, sel.endY),
    width: Math.abs(sel.endX - sel.startX),
    height: Math.abs(sel.endY - sel.startY),
  });

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    setSelection({ startX: e.clientX - rect.left, startY: e.clientY - rect.top, endX: e.clientX - rect.left, endY: e.clientY - rect.top });
    setIsDragging(true);
  };

  const handleOverlayMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !selection) return;
    const rect = overlayRef.current!.getBoundingClientRect();
    setSelection(s => s ? { ...s, endX: e.clientX - rect.left, endY: e.clientY - rect.top } : s);
  };

  const handleOverlayMouseUp = () => {
    if (!selection) return;
    setIsDragging(false);
    const r = getRelativeRect(selection);
    if (r.width > 10 && r.height > 10) setShowCommentPopup(true);
  };

  const handleSaveCapture = async () => {
    if (!selection) return;
    setIsSubmittingCapture(true);
    try {
      const result = await captureRegion(selectedPageUrl, getRelativeRect(selection), captureComment);
      setCaptures(prev => [...prev, { id: Date.now().toString(), filePath: result.filePath, comment: captureComment, pageUrl: selectedPageUrl }]);
    } finally {
      setIsSubmittingCapture(false);
      setShowCommentPopup(false);
      setCaptureComment('');
      setSelection(null);
      setIsCapturing(false);
    }
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
            {wpPages.length > 0 ? (
              <>
                {wpPages.map((page) => {
                  const isActive = selectedPageUrl === page.link;
                  return (
                    <div
                      key={page.id}
                      onClick={() => setSelectedPageUrl(page.link)}
                      className={`rounded-2xl p-4 flex flex-col gap-2 cursor-pointer transition-colors ${isActive ? 'border-2 border-[#49704F] bg-[#FAF7F0] shadow-sm' : 'bg-white border border-[#e8e6df] hover:border-[#dcd9ce]'}`}
                    >
                      {isActive && (
                        <div className="self-end bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">Editing</div>
                      )}
                      <div className="flex items-center gap-3">
                        <span className={`material-symbols-outlined text-[18px] ${isActive ? 'text-[#49704F]' : 'text-[#8e9892]'}`}>article</span>
                        <span className="font-bold text-[#233227] text-[14px]">{page.title}</span>
                      </div>
                      <span className="font-mono text-[10px] text-[#8e9892]">/{page.slug}</span>
                    </div>
                  );
                })}
              </>
            ) : (
              <>
                {/* Active Page (static fallback) */}
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

                {/* Inactive Pages (static fallback) */}
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
              </>
            )}

            <button className="w-full mt-4 bg-transparent border-2 border-dashed border-[#dcd9ce] rounded-full py-3 flex items-center justify-center gap-2 text-[#233227] font-bold text-[13px] hover:bg-[#e8e6df]/30 transition-colors">
              <span className="material-symbols-outlined text-[18px]">add_circle</span> Add new page
            </button>
          </div>
        </aside>

        {/* Center Canvas */}
        <main className="flex-1 bg-[#e8e6df]/50 relative flex justify-center overflow-hidden">

          {/* Toolbar */}
          <div className="absolute top-6 right-6 z-20 flex gap-2">
            <button
              onClick={() => { setIsCapturing(c => !c); setSelection(null); setShowCommentPopup(false); }}
              className={`text-[13px] font-bold px-4 py-2 rounded-full shadow-md flex items-center gap-2 transition-colors ${isCapturing ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-white border border-[#e8e6df] text-[#233227] hover:bg-[#f0ece4]'}`}
            >
              <span className="material-symbols-outlined text-[16px]">{isCapturing ? 'close' : 'crop'}</span>
              {isCapturing ? 'Huỷ' : 'Capture'}
            </button>
            {captures.length > 0 && (
              <button
                onClick={() => {
                  const newTags = captures.map(c => c.comment).filter(Boolean);
                  setChatTags(prev => [...prev, ...newTags]);
                  setCaptures([]);
                }}
                className="bg-[#e1ecd6] text-[#49704F] border border-[#c2d9b5] text-[13px] font-bold px-4 py-2 rounded-full shadow-md flex items-center gap-2 hover:bg-[#d2e0c6] transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">save</span> Save
              </button>
            )}
            <button
              onClick={() => setAnnotationsOpen(!annotationsOpen)}
              className="bg-[#49704F] text-white text-[13px] font-bold px-4 py-2 rounded-full shadow-md flex items-center gap-2 hover:bg-[#346E56] transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">visibility</span> Live Preview
            </button>
          </div>

          <div className="w-full h-full relative">
            {selectedPageUrl ? (
              <iframe
                src={`${import.meta.env.VITE_BACKEND_URL}/api/wp/proxy?url=${encodeURIComponent(selectedPageUrl)}`}
                className="w-full h-full border-none"
                title="Site Preview"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-[#8e9892] text-sm">
                Không có siteUrl. Hãy chọn một trang từ Project Selector.
              </div>
            )}
          </div>

          {/* Capture overlay */}
          {isCapturing && (
            <div
              ref={overlayRef}
              className="absolute inset-0 z-30"
              style={{ cursor: 'crosshair', background: 'rgba(0,0,0,0.15)' }}
              onMouseDown={handleOverlayMouseDown}
              onMouseMove={handleOverlayMouseMove}
              onMouseUp={handleOverlayMouseUp}
            >
              {selection && (() => {
                const r = getRelativeRect(selection);
                return (
                  <div
                    className="absolute border-2 border-[#49704F] bg-[#49704F]/10"
                    style={{ left: r.x, top: r.y, width: r.width, height: r.height, pointerEvents: 'none' }}
                  />
                );
              })()}
            </div>
          )}

          {/* Comment popup after capture */}
          {showCommentPopup && selection && (() => {
            const r = getRelativeRect(selection);
            return (
              <div
                className="absolute z-40 bg-white rounded-2xl shadow-xl border border-[#e8e6df] p-4 w-72"
                style={{ left: Math.min(r.x, window.innerWidth - 300), top: r.y + r.height + 8 }}
                onClick={e => e.stopPropagation()}
              >
                <p className="text-[13px] font-bold text-[#233227] mb-2">Thêm comment cho vùng này</p>
                <textarea
                  autoFocus
                  value={captureComment}
                  onChange={e => setCaptureComment(e.target.value)}
                  placeholder="Nhập comment..."
                  className="w-full border border-[#e8e6df] rounded-xl p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setShowCommentPopup(false); setSelection(null); }} className="text-[#5c6860] text-[12px] font-bold px-3 py-1.5 rounded-lg hover:bg-[#e8e6df]/50">Huỷ</button>
                  <button
                    onClick={handleSaveCapture}
                    disabled={isSubmittingCapture}
                    className="bg-[#49704F] disabled:opacity-50 text-white text-[12px] font-bold px-4 py-1.5 rounded-lg hover:bg-[#346E56]"
                  >
                    {isSubmittingCapture ? 'Đang chụp...' : 'Lưu'}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Preview chat toggle + collapsible chat panel */}
          <div className="absolute right-6 bottom-6 z-50 flex flex-col items-end gap-3 pointer-events-none">
            {isChatOpen && (
              <div className="max-w-[600px] max-h-[70vh] bg-white border border-[#d4d8d1] rounded-3xl shadow-xl backdrop-blur-md overflow-hidden pointer-events-auto">
                <div className="p-3 border-b border-[#e5e8df]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <h3 className="font-semibold text-sm text-[#2e3e2f]">Live Chat</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsChatOpen(false)}
                      className="text-[11px] text-[#7a836f] hover:text-[#233227] transition-colors"
                    >
                      Thu gọn
                    </button>
                  </div>
                  <p className="mt-2 text-[12px] text-[#5e6a5f]">Gợi ý: refactor header, tối ưu SEO, chuyển ngôn ngữ, kiểm tra Dependency</p>
                </div>

                <div className="p-3 flex flex-wrap gap-2">
                  {chatTags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setChatInput(tag)}
                      className="text-[11px] text-[#3f593b] bg-[#eff7ee] border border-[#d8e8d3] px-3 py-1.5 rounded-full hover:bg-[#e0f0df] transition-colors"
                    >
                      {tag}
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
            )}

            <button
              type="button"
              onClick={() => setIsChatOpen((prev) => !prev)}
              className="pointer-events-auto h-12 px-4 rounded-full bg-[#49704F] text-white shadow-lg flex items-center gap-2 hover:bg-[#346E56] transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">{isChatOpen ? 'close' : 'auto_awesome'}</span>
              <span className="text-[12px] font-bold">{isChatOpen ? 'Đóng chat' : 'Mở chat AI'}</span>
            </button>
          </div>

        </main>

        {/* Right Sidebar: Captures + Annotations */}
        {annotationsOpen && (
          <aside className="w-80 shrink-0 bg-[#FAF7F0] border-l border-[#e8e6df] flex flex-col z-10 transition-all duration-300">
            <div className="p-6 pb-4 border-b border-[#e8e6df]">
              <div className="flex justify-between items-center mb-1">
                <h2 className="font-headline text-[18px] font-bold text-[#1a2b21]">Annotations</h2>
                <span className="bg-[#e8d5a1] bg-opacity-40 text-[#7a5e18] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full border border-[#dcd9ce]">{annotations.length} Open</span>
              </div>
              <p className="text-[#5c6860] text-[13px]">Feedback from <span className="font-bold text-[#233227]">stakeholders</span>.</p>
            </div>

            {/* Captures section */}
            {captures.length > 0 && (
              <div className="px-4 pt-4 pb-2 border-b border-[#e8e6df]">
                <p className="text-[11px] font-bold text-[#8e9892] uppercase tracking-widest mb-3">Captures ({captures.length})</p>
                <div className="space-y-3">
                  {captures.map(cap => (
                    <div key={cap.id} className="bg-[#f5f3ee] rounded-xl overflow-hidden border border-[#e8e6df]">
                      <img
                        src={`${import.meta.env.VITE_BACKEND_URL}${cap.filePath}`}
                        alt="capture"
                        className="w-full object-cover max-h-28"
                      />
                      {cap.comment && <p className="text-[12px] text-[#5c6860] px-3 py-2">{cap.comment}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                onClick={() => { if (!activeTarget) setActiveTarget('block-1'); }}
                className="w-full bg-[#49704F] text-white text-[13px] font-bold py-3 rounded-full flex items-center justify-center gap-2 hover:bg-[#346E56] transition-colors shadow-sm"
              >
                <span className="material-symbols-outlined text-[16px]">add_comment</span> New Annotation
              </button>
            </div>
          </aside>
        )}
      </div>

    </div>
  );
};

export default Editor;
