import React, { useState } from "react";
import {
  Sparkles,
  Rocket,
  ShoppingBag,
  GraduationCap,
  Plus,
  CheckCircle2,
  CheckCircle,
  ArrowRight,
  ExternalLink,
  Key,
  Database,
  RefreshCw,
  Terminal,
} from "lucide-react";
import TopNav from "../components/TopNav";

// ─── Color tokens (xpress01 palette) ────────────────────────────────────────
const C = {
  green900: "#065F46",
  green800: "#044e3a",
  green700: "#006D3B",
  green500: "#00a85e",
  greenBg: "#E6F3EE",
  greenBgHover: "#D1E8DD",
  text1: "#1A1C1C",
  text2: "#3D4A3F",
  text3: "#71717A",
  bg: "#FAFAFA",
  border: "#E4E4E7",
  dashedBorder: "#BCCABF",
};

// ─── Types ───────────────────────────────────────────────────────────────────
type View = "landing" | "deploying" | "dashboard";

interface Template {
  id: string;
  title: string;
  category: string;
  icon: React.ReactNode;
  image: string;
}

// ─── Data ────────────────────────────────────────────────────────────────────
const templates: Template[] = [
  {
    id: "architect",
    title: "Architect Portfolio",
    category: "Professional / Portfolio",
    icon: <Sparkles className="w-5 h-5" style={{ color: C.green700 }} />,
    image:
      "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=800&auto=format&fit=crop",
  },
  {
    id: "minimal",
    title: "Studio Minimal",
    category: "Creative / Agency",
    icon: <Rocket className="w-5 h-5" style={{ color: C.green700 }} />,
    image:
      "https://images.unsplash.com/photo-1497366216548-37526070297c?q=80&w=800&auto=format&fit=crop",
  },
  {
    id: "eco",
    title: "Eco Commerce",
    category: "Retail / E-commerce",
    icon: <ShoppingBag className="w-5 h-5" style={{ color: C.green700 }} />,
    image:
      "https://images.unsplash.com/photo-1542838132-92c53300491e?q=80&w=800&auto=format&fit=crop",
  },
  {
    id: "lumina",
    title: "Lumina LMS",
    category: "Education / Learning",
    icon: <GraduationCap className="w-5 h-5" style={{ color: C.green700 }} />,
    image:
      "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?q=80&w=800&auto=format&fit=crop",
  },
];

const deploymentMessages = [
  "Khởi tạo tiến trình...",
  "Đang cấp phát ROM/RAM cho phiên bản độc lập...",
  "Spinning UP máy chủ ảo (Docker Container)...",
  "Tạo cơ sở dữ liệu WordPress hoàn chỉnh...",
  "Hoàn tất cấu hình mạng nội bộ!",
];


// ─── Deployment Modal ─────────────────────────────────────────────────────────
function DeploymentModal({ step }: { step: number }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(255,255,255,0.65)", backdropFilter: "blur(12px)" }}
    >
      <div
        className="bg-white p-8 rounded-2xl shadow-2xl max-w-md w-full border mx-4"
        style={{ borderColor: "#f0f0f0", animation: "fadeScaleIn 0.25s ease-out" }}
      >
        {/* Spinner */}
        <div className="flex justify-center mb-6">
          <div
            className="w-16 h-16 rounded-full border-4"
            style={{
              borderColor: "#f0f0f0",
              borderTopColor: C.green500,
              animation: "spin 1.5s linear infinite",
            }}
          />
        </div>

        <h2
          className="text-2xl font-bold text-center mb-2"
          style={{ color: C.text1 }}
        >
          Hệ thống đang Spin-up
        </h2>

        <div className="h-8 flex items-center justify-center mb-6">
          <p
            className="text-center font-medium transition-all"
            style={{ color: C.text2 }}
          >
            {deploymentMessages[Math.min(step, deploymentMessages.length - 1)]}
          </p>
        </div>

        <div className="space-y-3">
          {deploymentMessages.map((msg, idx) => (
            <div
              key={idx}
              className="flex items-center gap-3 transition-opacity"
              style={{ opacity: idx > step ? 0.3 : 1 }}
            >
              {idx < step ? (
                <CheckCircle2 className="w-5 h-5 flex-shrink-0" style={{ color: C.green500 }} />
              ) : idx === step ? (
                <div
                  className="w-5 h-5 flex-shrink-0 rounded-full border-2"
                  style={{
                    borderColor: C.green500,
                    borderTopColor: "white",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              ) : (
                <div
                  className="w-5 h-5 flex-shrink-0 rounded-full border-2"
                  style={{ borderColor: "#e5e7eb" }}
                />
              )}
              <span className="text-sm" style={{ color: C.text1 }}>
                {msg}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Landing View ─────────────────────────────────────────────────────────────
function LandingView({ onClone }: { onClone: () => void }) {
  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ backgroundColor: C.bg }}
    >
      <TopNav />

      <div className="flex-1 px-6 md:px-24 pt-32 pb-20">
        {/* Hero */}
        <section className="text-center max-w-4xl mx-auto mb-16">
          <h1
            className="text-4xl md:text-[56px] font-extrabold mb-6 tracking-tight leading-tight"
            style={{ color: C.text1 }}
          >
            Bắt đầu với một Template
          </h1>
          <p
            className="text-lg md:text-xl font-normal max-w-3xl mx-auto"
            style={{ color: C.text2 }}
          >
            Lựa chọn từ thư viện các bản thiết kế cao cấp dành cho WordPress,
            được tinh chỉnh bởi trí tuệ nhân tạo để mang lại trải nghiệm tối
            ưu.
          </p>
        </section>

        {/* Template Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="bg-white rounded-xl overflow-hidden border hover:shadow-xl transition-all duration-300 group flex flex-col"
              style={{ borderColor: "#f0f0f0", height: 400 }}
            >
              {/* Image */}
              <div
                className="overflow-hidden bg-gray-100"
                style={{ height: 216 }}
              >
                <img
                  src={tpl.image}
                  alt={tpl.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
              </div>

              {/* Content */}
              <div className="p-6 flex-1 flex flex-col justify-between">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3
                      className="font-bold text-lg mb-1"
                      style={{ color: C.text1 }}
                    >
                      {tpl.title}
                    </h3>
                    <p className="text-sm" style={{ color: C.text2 }}>
                      {tpl.category}
                    </p>
                  </div>
                  {tpl.icon}
                </div>

                <button
                  onClick={onClone}
                  className="w-full bg-black hover:bg-gray-800 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-colors"
                >
                  Clone Template
                </button>
              </div>
            </div>
          ))}

          {/* Custom Build Card */}
          <div
            className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer group transition-colors"
            style={{
              height: 400,
              backgroundColor: "#F9FAFA",
              borderColor: C.dashedBorder,
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.borderColor = C.green500)
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.borderColor =
                C.dashedBorder)
            }
            onClick={onClone}
          >
            <div className="w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-sm mb-4 group-hover:scale-110 transition-transform">
              <Plus className="w-8 h-8" style={{ color: C.green700 }} />
            </div>
            <h3
              className="font-bold text-lg mb-2"
              style={{ color: C.text1 }}
            >
              Custom Build
            </h3>
            <p
              className="text-sm text-center px-8"
              style={{ color: C.text2 }}
            >
              Bắt đầu từ trang trắng với AI Assistant
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Dashboard View ───────────────────────────────────────────────────────────
function DashboardView() {
  const [passwordVisible, setPasswordVisible] = useState(false);

  return (
    <div className="min-h-screen" style={{ backgroundColor: C.bg }}>
      <TopNav />

      {/* Main content */}
      <main className="pt-24 px-6 md:px-12 pb-16 max-w-5xl mx-auto">
          <div className="max-w-4xl mx-auto">
            {/* Success Banner */}
            <div
              className="bg-white rounded-2xl shadow-sm border p-8 mb-8 relative overflow-hidden"
              style={{ borderColor: C.greenBg }}
            >
              {/* Decorative blur circle */}
              <div
                className="absolute -right-20 -top-20 w-64 h-64 rounded-full pointer-events-none"
                style={{
                  backgroundColor: C.greenBg,
                  filter: "blur(48px)",
                  opacity: 0.5,
                }}
              />

              <div className="flex flex-col md:flex-row items-center md:items-start gap-6 relative z-10">
                {/* Icon */}
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center flex-shrink-0 mt-1"
                  style={{ backgroundColor: C.greenBg }}
                >
                  <CheckCircle
                    className="w-8 h-8"
                    style={{ color: C.green500 }}
                  />
                </div>

                <div className="text-center md:text-left">
                  <h1
                    className="text-2xl md:text-3xl font-extrabold mb-3 tracking-tight"
                    style={{ color: C.text1 }}
                  >
                    WordPress Instance Ready!
                  </h1>
                  <p
                    className="text-base md:text-lg mb-6 max-w-2xl leading-relaxed"
                    style={{ color: C.text2 }}
                  >
                    Môi trường WordPress phân mảnh của bạn đã được khởi tạo
                    thành công trên hạ tầng Docker. Tham khảo thông tin truy
                    cập Môi trường ngay bên dưới.
                  </p>

                  <div className="flex flex-col sm:flex-row gap-4 justify-center md:justify-start">
                    <a
                      href="#"
                      className="inline-flex items-center justify-center gap-2 text-white px-6 py-3.5 rounded-lg font-bold transition-all shadow-sm"
                      style={{ backgroundColor: C.green900 }}
                      onMouseEnter={(e) =>
                        ((e.currentTarget as HTMLElement).style.backgroundColor =
                          C.green800)
                      }
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLElement).style.backgroundColor =
                          C.green900)
                      }
                    >
                      Đến trang wp-admin
                      <ArrowRight className="w-4 h-4 ml-1" />
                    </a>
                    <a
                      href="#"
                      className="inline-flex items-center justify-center gap-2 bg-white border-2 border-gray-100 hover:border-gray-200 px-6 py-3.5 rounded-lg font-bold transition-all shadow-sm"
                      style={{ color: C.text1 }}
                    >
                      Xem Website Khách
                      <ExternalLink className="w-4 h-4 text-gray-500" />
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {/* Info Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Login Credentials */}
              <div
                className="bg-white p-8 rounded-2xl border shadow-sm"
                style={{ borderColor: "#f0f0f0" }}
              >
                <div className="flex items-center gap-3 mb-8">
                  <div className="p-2 bg-gray-50 rounded-lg">
                    <Key className="w-6 h-6" style={{ color: C.text3 }} />
                  </div>
                  <h2
                    className="text-xl font-bold"
                    style={{ color: C.text1 }}
                  >
                    Thông tin đăng nhập
                  </h2>
                </div>

                <div className="space-y-6">
                  {[
                    {
                      label: "URL Đăng nhập",
                      value: "https://demo-instance-8x2d.casso.press/wp-admin",
                    },
                    { label: "Tài khoản (Username)", value: "admin_casso_user" },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <label
                        className="block text-sm font-semibold mb-2 uppercase tracking-wide"
                        style={{ color: "#6b7280" }}
                      >
                        {label}
                      </label>
                      <div
                        className="p-3.5 rounded-lg font-mono text-sm break-all border shadow-inner"
                        style={{
                          backgroundColor: C.bg,
                          color: C.text1,
                          borderColor: "#e5e7eb",
                        }}
                      >
                        {value}
                      </div>
                    </div>
                  ))}

                  {/* Password */}
                  <div>
                    <label
                      className="block text-sm font-semibold mb-2 uppercase tracking-wide"
                      style={{ color: "#6b7280" }}
                    >
                      Mật khẩu tự sinh
                    </label>
                    <div className="flex gap-2">
                      <div
                        className="p-3.5 rounded-lg font-mono text-sm flex-1 border shadow-inner flex items-center"
                        style={{
                          backgroundColor: C.bg,
                          color: C.text1,
                          borderColor: "#e5e7eb",
                        }}
                      >
                        {passwordVisible ? "X3k#9mPq!2wZ" : "••••••••••••"}
                      </div>
                      <button
                        onClick={() => setPasswordVisible((v) => !v)}
                        className="px-5 py-2 bg-white hover:bg-gray-50 text-sm font-bold rounded-lg transition-colors border-2 border-gray-100 shadow-sm"
                        style={{ color: C.text1 }}
                      >
                        {passwordVisible ? "Hide" : "Copy"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Instance Specs */}
              <div
                className="bg-white p-8 rounded-2xl border shadow-sm flex flex-col"
                style={{ borderColor: "#f0f0f0" }}
              >
                <div className="flex items-center gap-3 mb-8">
                  <div className="p-2 bg-gray-50 rounded-lg">
                    <Database className="w-6 h-6" style={{ color: C.text3 }} />
                  </div>
                  <h2
                    className="text-xl font-bold"
                    style={{ color: C.text1 }}
                  >
                    Thông số Instance
                  </h2>
                </div>

                <div className="space-y-6 flex-1">
                  {[
                    {
                      label: "Mã định danh Container",
                      value: "dx_7f4a2b9",
                      badge: true,
                    },
                    { label: "RAM Cấp phát", value: "1024 MB" },
                    { label: "Dung lượng Database", value: "5GB Quota" },
                    { label: "Phiên bản WordPress", value: "v6.4.3" },
                  ].map(({ label, value, badge }, idx, arr) => (
                    <div
                      key={label}
                      className="flex justify-between items-center pb-4"
                      style={
                        idx < arr.length - 1
                          ? { borderBottom: "1px solid #f0f0f0" }
                          : {}
                      }
                    >
                      <span
                        className="font-medium"
                        style={{ color: "#6b7280" }}
                      >
                        {label}
                      </span>
                      {badge ? (
                        <span
                          className="font-mono text-sm font-semibold px-3 py-1 rounded-md"
                          style={{
                            color: C.green900,
                            backgroundColor: C.greenBg,
                          }}
                        >
                          {value}
                        </span>
                      ) : (
                        <span
                          className="font-bold"
                          style={{ color: C.text1 }}
                        >
                          {value}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-8 flex gap-3">
                  {[
                    { icon: RefreshCw, label: "Khởi động lại" },
                    { icon: Terminal, label: "Xem Logs" },
                  ].map(({ icon: Icon, label }) => (
                    <button
                      key={label}
                      className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold rounded-lg border-2 border-gray-100 hover:bg-gray-50 transition-colors shadow-sm"
                      style={{ color: "#374151" }}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
const TemplateStore: React.FC = () => {
  const [view, setView] = useState<View>("landing");
  const [deployStep, setDeployStep] = useState(0);

  const handleClone = () => {
    setView("deploying");
    setDeployStep(0);
    let step = 0;
    const interval = setInterval(() => {
      step += 1;
      setDeployStep(step);
      if (step >= deploymentMessages.length) {
        clearInterval(interval);
        setTimeout(() => setView("dashboard"), 800);
      }
    }, 1200);
  };

  return (
    <>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes fadeScaleIn {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {view === "dashboard" ? (
        <DashboardView />
      ) : (
        <>
          <LandingView onClone={handleClone} />
          {view === "deploying" && <DeploymentModal step={deployStep} />}
        </>
      )}
    </>
  );
};

export default TemplateStore;
