import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

const Onboarding: React.FC = () => {
  const navigate = useNavigate();
  const [downloaded, setDownloaded] = useState(false);

  return (
    <div className="flex flex-col w-full pb-24">
      <section className="w-full max-w-3xl mx-auto px-8 py-16 flex flex-col justify-center min-h-[calc(100vh-120px)] shrink-0">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-headline text-[32px] font-bold text-[#233227] leading-tight mb-3">
            Welcome to X-press AI
          </h1>
          <p className="text-[#5c6860] text-[15px] font-medium max-w-lg">
            Download and install the plugin to connect your WordPress site to the X-press AI engine.
          </p>
        </div>

        {/* Download Panel */}
        <div className="bg-[#FAF7F0] border-2 border-dashed border-[#dcd9ce] rounded-3xl p-10 flex flex-col items-center text-center mb-6">
          <div className="w-16 h-16 bg-[#e8e6df] rounded-full flex items-center justify-center text-[#49704F] mb-6">
            <span className="material-symbols-outlined text-[28px]">cloud_download</span>
          </div>
          <h3 className="font-headline text-2xl font-bold text-[#1a2b21] mb-3">
            Download Plugin ZIP
          </h3>
          <p className="text-[#5c6860] text-[15px] leading-relaxed max-w-sm mb-6">
            Download{" "}
            <code className="bg-[#e8e6df] text-[#233227] px-1.5 py-0.5 rounded text-sm">
              vibepress.zip
            </code>{" "}
            rồi upload lên WordPress tại{" "}
            <span className="font-semibold text-[#233227]">Plugins → Add New → Upload Plugin</span>.
          </p>
          <a
            href="/vibepress-db-info.zip"
            download="vibepress-db-info.zip"
            onClick={() => setDownloaded(true)}
            className="bg-[#49704F] hover:bg-[#346E56] text-white text-[14px] font-bold px-10 py-3 rounded-full shadow-sm transition-all mb-3 inline-flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Download Plugin
          </a>
          <p className="text-[12px] text-[#8e9892]">File size: 7.8 KB</p>
        </div>

        {/* Continue notice — hiện sau khi download */}
        {downloaded && (
          <div className="bg-[#edf5ee] border border-[#c6ddc8] rounded-2xl p-5 flex gap-4 items-center">
            <span className="material-symbols-outlined text-[22px] text-[#49704F] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
            <div className="flex-1">
              <p className="text-[14px] font-semibold text-[#2e5435] mb-0.5">Plugin đã được tải xuống</p>
              <p className="text-[13px] text-[#5c6860]">
                Cài đặt plugin trên WordPress, sau đó nhấn <span className="font-bold">Tiếp tục</span> để kết nối tài khoản.
              </p>
            </div>
            <button
              onClick={() => navigate("/app/projects")}
              className="shrink-0 bg-[#49704F] hover:bg-[#346E56] text-white text-[13px] font-bold px-5 py-2.5 rounded-full transition-colors"
            >
              Tiếp tục →
            </button>
          </div>
        )}

        {/* Already installed */}
        {!downloaded && (
          <div className="bg-white border border-[#e8e6df] rounded-2xl p-4 flex gap-3 items-center">
            <span className="material-symbols-outlined text-[18px] text-[#8e9892] shrink-0">info</span>
            <p className="text-[13px] text-[#5c6860]">
              Đã cài plugin rồi?{" "}
              <button
                onClick={() => navigate("/app/projects")}
                className="font-bold text-[#49704F] underline underline-offset-2 hover:text-[#346E56] transition-colors"
              >
                Tiếp tục ngay
              </button>
            </p>
          </div>
        )}

        {/* Security Info */}
        <div className="bg-[#f0eede] border border-[#e6e2cd] rounded-2xl p-5 flex gap-4 items-start mt-6">
          <div className="w-6 h-6 rounded-full bg-[#8c8874] text-white flex items-center justify-center shrink-0 mt-0.5">
            <span className="material-symbols-outlined text-[14px]">lock</span>
          </div>
          <div>
            <h4 className="text-[14px] font-bold text-[#233227] mb-1">Bảo mật cài đặt</h4>
            <p className="text-[13px] text-[#5c6860] leading-relaxed">
              Plugin được ký số và bảo mật. X-press AI không chỉnh sửa các file lõi WordPress.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Onboarding;
