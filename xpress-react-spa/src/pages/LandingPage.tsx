import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';

type AuthTab = 'login' | 'register';
type AuthField = { email: string; password: string; confirmPassword: string };

const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, setAuth, clearAuth } = useUser();

  const [showModal, setShowModal]       = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyCopied, setApiKeyCopied]       = useState(false);

  const copyApiKey = () => {
    if (!user?.apiKey) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(user.apiKey);
    } else {
      const el = document.createElement("textarea");
      el.value = user.apiKey;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setApiKeyCopied(true);
    setTimeout(() => setApiKeyCopied(false), 2000);
  };
  const [tab, setTab]               = useState<AuthTab>('login');
  const [fields, setFields]         = useState<AuthField>({ email: '', password: '', confirmPassword: '' });
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);

  const openModal = (defaultTab: AuthTab = 'login') => {
    setTab(defaultTab);
    setFields({ email: '', password: '', confirmPassword: '' });
    setError('');
    setShowModal(true);
  };

  const handleField = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFields(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (tab === 'register' && fields.password !== fields.confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }

    setLoading(true);
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fields.email, password: fields.password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Đã có lỗi xảy ra');
        return;
      }

      setAuth(data.user, data.token);
      setShowModal(false);
      navigate('/app/onboarding');
    } catch {
      setError('Không thể kết nối đến server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="antialiased overflow-x-hidden font-body bg-[#faf6f0] text-[#2e3230] leading-[1.6]">
      {/* TopNavBar */}
      <nav className="fixed top-0 w-full z-50 bg-[#faf6f0]/80 backdrop-blur-md border-b border-[#4a7c59]/10 shadow-[0_4px_20px_rgba(46,50,48,0.06)]">
          <div className="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto">
              <div className="flex items-center gap-8">
                  <span className="font-headline text-2xl font-bold text-[#4a7c59]">X-press</span>
                  <div className="hidden md:flex gap-6 font-semibold text-sm">
                      <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Product</a>
                      <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Features</a>
                      <a href="#" className="text-stone-600 hover:text-[#4a7c59] transition-colors">Pricing</a>
                      {user && (
                        <button onClick={() => setShowApiKeyModal(true)} className="text-stone-600 hover:text-[#4a7c59] transition-colors font-semibold text-sm">API Key</button>
                      )}
                  </div>
              </div>
              <div className="flex items-center gap-4">
                  <div className="flex items-center gap-4">
                  {user ? (
                    <div className="flex items-center gap-3">
                      <span className="text-stone-600 font-semibold text-sm">Xin chào, {user.email}</span>
                      <button onClick={clearAuth} className="text-xs text-stone-400 hover:text-stone-600 transition-colors">Đăng xuất</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => openModal('login')} className="text-stone-600 font-semibold text-sm hover:opacity-80 transition-opacity">Đăng nhập</button>
                      <button onClick={() => openModal('register')} className="border border-[#4a7c59] text-[#4a7c59] px-4 py-1.5 rounded-lg font-semibold text-sm hover:bg-[#4a7c59]/5 transition-colors">Đăng ký</button>
                    </div>
                  )}
                  <button 
                    onClick={() => navigate('/app/onboarding')}
                    className="bg-[#4a7c59] text-white px-5 py-2 rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity active:scale-95 duration-150"
                  >
                    Get Started
                  </button>
              </div>
          </div>
      </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-6 max-w-7xl mx-auto overflow-hidden">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div className="space-y-8">
                  <span className="bg-[#f8e0a8] text-[#221a05] px-4 py-1.5 rounded-full text-sm font-bold tracking-wide">AI-POWERED WORDPRESS</span>
                  <h1 className="text-5xl md:text-6xl font-headline font-extrabold text-[#2e3230] leading-[1.1]">
                      Biến Website WordPress thành <span className="text-[#4a7c59]">'Cỗ máy bán hàng'</span> đa năng bằng AI
                  </h1>
                  <p className="text-lg text-[#4a4e4a] max-w-xl">
                      Tự động làm mới giao diện cho các dịp Tết, Lễ chỉ bằng Prompt. Tăng tỷ lệ chuyển đổi với Gamification (Vòng quay may mắn) và hiệu năng React mượt mà.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-4">
                      <button 
                        onClick={() => navigate('/app/onboarding')}
                        className="bg-[#4a7c59] text-white px-8 py-4 rounded-xl font-bold text-lg shadow-lg hover:opacity-90 transition-all flex items-center justify-center gap-2"
                      >
                          Làm mới Website của bạn ngay
                          <span className="material-symbols-outlined">arrow_forward</span>
                      </button>
                      <button className="bg-white border-2 border-[#4a7c59]/20 text-[#4a7c59] px-8 py-4 rounded-xl font-bold text-lg hover:bg-[#4a7c59]/5 transition-all">
                          Xem demo thực tế
                      </button>
                  </div>
              </div>
              <div className="relative">
                  <div className="bg-[#f0ece4] rounded-3xl p-4 shadow-xl border border-[#c4c8bc]/30">
                      <div className="relative rounded-2xl overflow-hidden aspect-video group">
                          {/* Comparison Logic Visualized */}
                          <div className="absolute inset-0 flex">
                              <div className="w-1/2 relative">
                                  <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuCj_uVIsm7hJf2Wtdo0_ZP6TWvAUO_ib4rDwbuNM3-Sjhk0vGajKCohUTcZPwFWZZfg4Y0p6_nxh4HEDxJ7vBI1x2BMPsH9H1hq-SeC50OvfNrYxS2M8P7d9LTdWIqd4eoGK4e2x6sW1o1VxVMgn-E2LZfzq_ugq3r3V2OD7w7Evf6QkeyZ7VVn860JRX1CvGBn9ygwW62iZydUvRv8opKMEic_e_7pqdDZDfvUXVETjVKMTAFVSxLrIOX4NOfMsw4LV7p_2a4K9gE" className="absolute inset-0 w-full h-full object-cover grayscale opacity-60" alt="Cũ & Tẻ nhạt" />
                                  <div className="absolute top-4 left-4 bg-[#2e3230] text-white px-3 py-1 text-xs rounded-full uppercase tracking-widest font-bold">Cũ & Tẻ nhạt</div>
                              </div>
                              <div className="w-1/2 relative border-l-4 border-[#4a7c59] z-10 shadow-[-10px_0_30px_rgba(0,0,0,0.2)]">
                                  <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuBGn8oZA1Wgt5Dyy-EhwaaYkkBPA0RDoVJtOv__8JzU0Pq26F0Y7E29Liyf8h3ymtn1R6GhjRoVVIOQAXeFfOzFpK62ooWDukTiARwYeudtQG5u4Un8uxXqGkZY1hE3Px1pmqoNd5phhcSTpemx4Olo7_Rxr6-nc9T5-tpH6vWiZuG42ClmrjUUQL5JOXceEDJhLKHcGzt9_mUzRavOfd18v7nUNgVzzf8t0dW2AZ74j9OkI1r20HDAhIYRTlhg-IOkKeFoWFX9LN0" className="absolute inset-0 w-full h-full object-cover" alt="X-press AI" />
                                  <div className="absolute top-4 right-4 bg-[#4a7c59] text-white px-3 py-1 text-xs rounded-full uppercase tracking-widest font-bold">X-press AI</div>
                              </div>
                          </div>
                          {/* Slider Handle UI */}
                          <div className="absolute inset-y-0 left-1/2 -ml-0.5 w-1 bg-[#4a7c59] z-20 flex items-center justify-center">
                              <div className="w-10 h-10 bg-[#4a7c59] rounded-full shadow-lg flex items-center justify-center text-white cursor-pointer">
                                  <span className="material-symbols-outlined text-sm">unfold_more</span>
                              </div>
                          </div>
                      </div>
                  </div>
                  {/* Decorative Elements */}
                  <div className="absolute -top-6 -right-6 w-32 h-32 bg-[#705c30]/10 rounded-full blur-3xl -z-10"></div>
                  <div className="absolute -bottom-10 -left-10 w-48 h-48 bg-[#4a7c59]/10 rounded-full blur-3xl -z-10"></div>
              </div>
          </div>
      </section>

      {/* Pain Points: Bento Grid */}
      <section className="py-24 bg-[#f5f1ea] px-6">
          <div className="max-w-7xl mx-auto">
              <div className="text-center max-w-2xl mx-auto mb-16">
                  <h2 className="text-4xl font-headline font-bold mb-4">Nỗi kinh hoàng khi quản trị WordPress truyền thống</h2>
                  <p className="text-[#4a4e4a]">Bạn đang phí phạm thời gian và tiền bạc cho những thứ đáng lẽ phải dễ dàng hơn.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-[#faf6f0] rounded-2xl p-8 border border-[#c4c8bc]/20 shadow-sm">
                      <div className="w-12 h-12 bg-[#b83230]/10 text-[#b83230] rounded-xl flex items-center justify-center mb-6">
                          <span className="material-symbols-outlined">event_busy</span>
                      </div>
                      <h3 className="text-xl font-headline font-bold mb-4">Thay áo mùa lễ hội là "ác mộng"</h3>
                      <p className="text-[#4a4e4a] text-sm">Tốn hàng tuần để thiết kế lại banner, màu sắc, font chữ cho mỗi dịp Tết, Trung Thu hay Noel. Quá chậm trễ!</p>
                  </div>
                  <div className="bg-[#faf6f0] rounded-2xl p-8 border border-[#c4c8bc]/20 shadow-sm">
                      <div className="w-12 h-12 bg-[#b83230]/10 text-[#b83230] rounded-xl flex items-center justify-center mb-6">
                          <span className="material-symbols-outlined">extension_off</span>
                      </div>
                      <h3 className="text-xl font-headline font-bold mb-4">Xung đột Plugin triền miên</h3>
                      <p className="text-[#4a4e4a] text-sm">Cài thêm vòng quay may mắn, popup sale hay gamification là website lại "vỡ" layout hoặc chậm như rùa.</p>
                  </div>
                  <div className="bg-[#faf6f0] rounded-2xl p-8 border border-[#c4c8bc]/20 shadow-sm">
                      <div className="w-12 h-12 bg-[#b83230]/10 text-[#b83230] rounded-xl flex items-center justify-center mb-6">
                          <span className="material-symbols-outlined">query_stats</span>
                      </div>
                      <h3 className="text-xl font-headline font-bold mb-4">Mù mờ về dữ liệu khách hàng</h3>
                      <p className="text-[#4a4e4a] text-sm">Chỉ biết số lượt truy cập. Không hiểu khách hàng đang quan tâm gì, họ dừng lại ở đâu, tại sao không mua hàng.</p>
                  </div>
              </div>
          </div>
      </section>

      {/* Solution: Enhance instead of Migrate */}
      <section className="py-24 px-6 max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center gap-16">
              <div className="w-full md:w-1/2 relative">
                  <div className="aspect-square bg-[#4a7c59]/5 rounded-[3rem] p-12 overflow-hidden flex items-center justify-center">
                      <div className="grid grid-cols-2 gap-4 w-full">
                          <div className="bg-white p-6 rounded-2xl shadow-md space-y-3 transform -rotate-3 translate-y-4">
                              <div className="w-8 h-8 rounded-full bg-[#4a7c59]/10 flex items-center justify-center text-[#4a7c59]">
                                  <span className="material-symbols-outlined text-sm">auto_awesome</span>
                              </div>
                              <div className="h-2 w-20 bg-stone-200 rounded"></div>
                              <div className="h-2 w-full bg-stone-100 rounded"></div>
                          </div>
                          <div className="bg-white p-6 rounded-2xl shadow-md space-y-3 transform rotate-6">
                              <div className="w-8 h-8 rounded-full bg-[#705c30]/10 flex items-center justify-center text-[#705c30]">
                                  <span className="material-symbols-outlined text-sm">celebration</span>
                              </div>
                              <div className="h-2 w-24 bg-stone-200 rounded"></div>
                              <div className="h-2 w-full bg-stone-100 rounded"></div>
                          </div>
                          <div className="bg-white p-6 rounded-2xl shadow-md space-y-3 transform -rotate-6 translate-x-4">
                              <div className="w-8 h-8 rounded-full bg-[#4a7c59]/20 flex items-center justify-center text-[#4a7c59]">
                                  <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>rocket_launch</span>
                              </div>
                              <div className="h-2 w-16 bg-stone-200 rounded"></div>
                          </div>
                          <div className="bg-white p-6 rounded-2xl shadow-md space-y-3 transform rotate-3">
                              <div className="w-8 h-8 rounded-full bg-[#6b6358]/10 flex items-center justify-center text-[#6b6358]">
                                  <span className="material-symbols-outlined text-sm">monitoring</span>
                              </div>
                              <div className="h-2 w-full bg-stone-100 rounded"></div>
                          </div>
                      </div>
                  </div>
              </div>
              <div className="w-full md:w-1/2 space-y-8">
                  <h2 className="text-4xl font-headline font-bold leading-tight">"Nâng cấp" Website, không phải xây lại từ đầu</h2>
                  <div className="space-y-6">
                      <div className="flex gap-4">
                          <div className="flex-shrink-0 w-10 h-10 bg-[#4a7c59] rounded-full flex items-center justify-center text-white">
                              <span className="material-symbols-outlined text-sm">chat</span>
                          </div>
                          <div>
                              <h4 className="font-headline font-bold text-lg">Thay đổi diện mạo qua Prompt</h4>
                              <p className="text-[#4a4e4a] italic">"Thay đổi giao diện sang chủ đề Trung Thu với tone màu vàng nâu ấm"</p>
                          </div>
                      </div>
                      <div className="flex gap-4">
                          <div className="flex-shrink-0 w-10 h-10 bg-[#4a7c59] rounded-full flex items-center justify-center text-white">
                              <span className="material-symbols-outlined text-sm">smart_toy</span>
                          </div>
                          <div>
                              <h4 className="font-headline font-bold text-lg">Tính năng độc bản từ AI</h4>
                              <p className="text-[#4a4e4a] italic">"Tạo vòng quay may mắn tặng mã giảm giá 10% cho khách mới"</p>
                          </div>
                      </div>
                      <div className="flex gap-4">
                          <div className="flex-shrink-0 w-10 h-10 bg-[#4a7c59] rounded-full flex items-center justify-center text-white">
                              <span className="material-symbols-outlined text-sm">flash_on</span>
                          </div>
                          <div>
                              <h4 className="font-headline font-bold text-lg">Động cơ React siêu tốc</h4>
                              <p className="text-[#4a4e4a]">Trải nghiệm ứng dụng mượt mà trên nền tảng WordPress ổn định.</p>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      </section>

      {/* Feature Highlights */}
      <section className="py-24 px-6 bg-[#faf6f0]">
          <div className="max-w-7xl mx-auto">
              <div className="bg-[#4a7c59] text-white rounded-[2.5rem] p-12 md:p-20 shadow-2xl overflow-hidden relative">
                  <div className="relative z-10 grid md:grid-cols-2 gap-16 items-center">
                      <div>
                          <h2 className="text-4xl font-headline font-bold mb-8">Trải nghiệm quản trị hiện đại, tập trung vào tăng trưởng</h2>
                          <div className="grid gap-8">
                              <div className="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-white/20">
                                  <h4 className="font-headline font-bold text-xl mb-2 flex items-center gap-2">
                                      <span className="material-symbols-outlined">dashboard</span>
                                      Smart Dashboard
                                  </h4>
                                  <p className="text-[#d8f0de]/80 text-sm">Theo dõi hành vi khách hàng theo thời gian thực. Biết chính xác sản phẩm nào đang "hot".</p>
                              </div>
                              <div className="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-white/20">
                                  <h4 className="font-headline font-bold text-xl mb-2 flex items-center gap-2">
                                      <span className="material-symbols-outlined">search_insights</span>
                                      Auto-SEO Assistant
                                  </h4>
                                  <p className="text-[#d8f0de]/80 text-sm">AI tự động tối ưu hóa nội dung, thẻ meta và hình ảnh để đưa website lên top Google.</p>
                              </div>
                              <div className="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-white/20">
                                  <h4 className="font-headline font-bold text-xl mb-2 flex items-center gap-2">
                                      <span className="material-symbols-outlined">inventory_2</span>
                                      Quản lý bán hàng tập trung
                                  </h4>
                                  <p className="text-[#d8f0de]/80 text-sm">Đơn hàng, kho bãi, khách hàng được quản lý đồng nhất trong một giao diện duy nhất.</p>
                              </div>
                          </div>
                      </div>
                      <div className="hidden md:block">
                          <img src="https://lh3.googleusercontent.com/aida-public/AB6AXuBawhMx2EvZerFDfk59WsHBZgpTlB11knr6PIO-B66RVCpbNHuFg_DUiJ9ijkX1aSCF3qnzcXIVRels2XPOqFg6YFghHBmmz7VC1mdhatH8CGi-ZN5zWNx9Ga_p9DDPQJnMtMcTIhyn1ANMtC_OcA42thLGDqyqnoWvTVhNR5oqj6n2gikcNbmmwYlfGZ9HZ3XFmJlgA19E8PRA5WkvrndvknpOeP5y_x85yoDbdJZJDQ9i6tKaHf8WthICzVAS2yrI953Gt0aQb9s" className="rounded-3xl shadow-2xl transform rotate-2" alt="Dashboard Map" />
                      </div>
                  </div>
                  {/* Abstract shape */}
                  <div className="absolute top-0 right-0 w-full h-full bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.1),transparent)] pointer-events-none"></div>
              </div>
          </div>
      </section>

      {/* How It Works */}
      <section className="py-24 px-6 max-w-7xl mx-auto">
          <div className="text-center mb-16">
              <h2 className="text-4xl font-headline font-bold mb-4">4 bước đơn giản để bứt phá doanh số</h2>
          </div>
          <div className="grid md:grid-cols-4 gap-8">
              <div className="relative text-center group">
                  <div className="w-16 h-16 bg-[#f0ece4] rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-[#4a7c59] transition-colors">
                      <span className="material-symbols-outlined text-[#4a7c59] group-hover:text-white">electrical_services</span>
                  </div>
                  <h4 className="font-headline font-bold text-lg mb-2">Fast Connect</h4>
                  <p className="text-sm text-[#4a4e4a]">Cài đặt Plugin X-press vào website WordPress hiện có của bạn.</p>
                  <div className="hidden md:block absolute top-8 -right-4 w-8 h-px bg-[#c4c8bc]"></div>
              </div>
              <div className="relative text-center group">
                  <div className="w-16 h-16 bg-[#f0ece4] rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-[#4a7c59] transition-colors">
                      <span className="material-symbols-outlined text-[#4a7c59] group-hover:text-white">forum</span>
                  </div>
                  <h4 className="font-headline font-bold text-lg mb-2">Chat với AI</h4>
                  <p className="text-sm text-[#4a4e4a]">Chọn phân vùng website và gõ Prompt yêu cầu thay đổi.</p>
                  <div className="hidden md:block absolute top-8 -right-4 w-8 h-px bg-[#c4c8bc]"></div>
              </div>
              <div className="relative text-center group">
                  <div className="w-16 h-16 bg-[#f0ece4] rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-[#4a7c59] transition-colors">
                      <span className="material-symbols-outlined text-[#4a7c59] group-hover:text-white">preview</span>
                  </div>
                  <h4 className="font-headline font-bold text-lg mb-2">Review</h4>
                  <p className="text-sm text-[#4a4e4a]">Xem trước giao diện và tính năng mới trong môi trường Live Preview.</p>
                  <div className="hidden md:block absolute top-8 -right-4 w-8 h-px bg-[#c4c8bc]"></div>
              </div>
              <div className="text-center group">
                  <div className="w-16 h-16 bg-[#f0ece4] rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-[#4a7c59] transition-colors">
                      <span className="material-symbols-outlined text-[#4a7c59] group-hover:text-white">rocket</span>
                  </div>
                  <h4 className="font-headline font-bold text-lg mb-2">Public</h4>
                  <p className="text-sm text-[#4a4e4a]">Cập nhật ngay lập tức giao diện mới cho khách hàng trải nghiệm.</p>
              </div>
          </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 px-6">
          <div className="max-w-4xl mx-auto bg-[#f0ece4] rounded-[2rem] p-12 text-center border border-[#c4c8bc]/30 relative overflow-hidden">
              <div className="relative z-10">
                  <h2 className="text-4xl font-headline font-bold mb-6">Đừng để website của bạn lỗi thời trong mắt khách hàng</h2>
                  <p className="text-lg text-[#4a4e4a] mb-10 max-w-2xl mx-auto">Tham gia cùng +500 thương hiệu đã nâng cấp website WordPress của họ thành những cỗ máy bán hàng hiện đại.</p>
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
                      <button 
                        onClick={() => navigate('/app/onboarding')}
                        className="bg-[#4a7c59] text-white px-10 py-4 rounded-xl font-bold hover:shadow-lg transition-all"
                      >
                        Dùng thử miễn phí
                      </button>
                      <button className="bg-white text-[#2e3230] px-10 py-4 rounded-xl font-bold border border-[#c4c8bc]/50 hover:bg-stone-50 transition-all">
                        Xem các mẫu Theme sự kiện
                      </button>
                  </div>
              </div>
              <div className="absolute top-0 left-0 w-full h-full opacity-5 pointer-events-none" style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBofRI0YmDxdHFB0h_yyjEFEcyDVOZnxP2Kjt5oajIaxUlOBeU6_uto_XGfX1E1MBFrxlVMJuveJh5WF4oWD9AYT5EfjKX6-5xLlTiyu78wlpK_gQINpZa_Ee_jihRiWkZySvqPyd0b-e_fC4SYV6gS7FhwNHoxqWpGPN3tyc7q4lkjrmpTYpB8Oky9nOVb88goAB8P3B5Y48oOc5vJuTWpESDgQIOQRYstuMBeTttUpS3wd5gP9RM5KJO1OqUXgqtewJdfysXSfIs')" }}></div>
          </div>
      </section>

      {/* API Key Modal */}
      {showApiKeyModal && user && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowApiKeyModal(false)}>
          <div className="bg-[#faf6f0] rounded-2xl shadow-2xl p-8 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <h2 className="font-headline text-xl font-bold text-[#2e3230] mb-1">API Key của bạn</h2>
            <p className="text-sm text-[#4a4e4a] mb-6">Dùng key này để kết nối WordPress plugin với Vibepress.</p>

            <div className="flex items-center gap-2 bg-white border border-[#c4c8bc] rounded-xl px-4 py-3 mb-4">
              <code className="flex-1 text-sm text-[#2e3230] break-all select-all">{user.apiKey}</code>
              <button
                onClick={copyApiKey}
                className="flex-shrink-0 text-[#4a7c59] hover:opacity-70 transition-opacity"
                title="Copy"
              >
                <span className="material-symbols-outlined text-xl">
                  {apiKeyCopied ? 'check' : 'content_copy'}
                </span>
              </button>
            </div>

            {apiKeyCopied && <p className="text-xs text-[#4a7c59] mb-4">Đã copy!</p>}

            <button onClick={() => setShowApiKeyModal(false)} className="w-full text-center text-xs text-stone-400 hover:text-stone-600 transition-colors">Đóng</button>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div className="bg-[#faf6f0] rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>

            {/* Tabs */}
            <div className="flex mb-6 bg-[#f0ece4] rounded-xl p-1">
              <button
                onClick={() => { setTab('login'); setError(''); }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${tab === 'login' ? 'bg-white text-[#2e3230] shadow-sm' : 'text-stone-500 hover:text-stone-700'}`}
              >Đăng nhập</button>
              <button
                onClick={() => { setTab('register'); setError(''); }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${tab === 'register' ? 'bg-white text-[#2e3230] shadow-sm' : 'text-stone-500 hover:text-stone-700'}`}
              >Đăng ký</button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                name="email"
                type="email"
                required
                autoFocus
                placeholder="Email"
                value={fields.email}
                onChange={handleField}
                className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
              />
              <input
                name="password"
                type="password"
                required
                placeholder="Mật khẩu"
                value={fields.password}
                onChange={handleField}
                className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
              />
              {tab === 'register' && (
                <input
                  name="confirmPassword"
                  type="password"
                  required
                  placeholder="Xác nhận mật khẩu"
                  value={fields.confirmPassword}
                  onChange={handleField}
                  className="w-full border border-[#c4c8bc] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#4a7c59] transition-colors bg-white"
                />
              )}

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#4a7c59] text-white py-3 rounded-xl font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {loading ? 'Đang xử lý...' : tab === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
              </button>
            </form>

            <button onClick={() => setShowModal(false)} className="mt-4 w-full text-center text-xs text-stone-400 hover:text-stone-600 transition-colors">Huỷ</button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-stone-100 w-full py-12 px-6 border-t border-[#4a7c59]/10">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 max-w-7xl mx-auto">
              <div className="md:col-span-2">
                  <span className="font-headline text-xl font-bold text-[#4a7c59] block mb-4">X-press AI</span>
                  <p className="text-sm leading-relaxed text-stone-500 max-w-sm mb-6">Nền tảng tiên phong ứng dụng AI để cá nhân hóa trải nghiệm người dùng trên WordPress, mang lại sự linh hoạt và tăng trưởng vượt bậc cho doanh nghiệp.</p>
                  <p className="text-sm text-stone-500">© 2026 X-press AI. Rooted in WordPress.</p>
              </div>
              <div>
                  <h5 className="font-bold text-[#4a7c59] mb-4">Resources</h5>
                  <div className="flex flex-col gap-2 text-sm text-stone-500">
                      <a href="#" className="hover:text-[#705c30] transition-colors">Documentation</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">API Reference</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">Community</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">Blog</a>
                  </div>
              </div>
              <div>
                  <h5 className="font-bold text-[#4a7c59] mb-4">Legal & Social</h5>
                  <div className="flex flex-col gap-2 text-sm text-stone-500">
                      <a href="#" className="hover:text-[#705c30] transition-colors">Privacy Policy</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">Terms of Service</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">Twitter</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">LinkedIn</a>
                      <a href="#" className="hover:text-[#705c30] transition-colors">Newsletter</a>
                  </div>
              </div>
          </div>
      </footer>
    </div>
  );
};


export default LandingPage;
