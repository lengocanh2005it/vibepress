import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const SplitView: React.FC = () => {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<string[]>([]);
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const steps = [
      'Reading context...',
      'Parsing project structure...',
      'Extracting CSS variables...',
      'Generating React components...',
      'Creating preview canvas...',
      'Finalizing UI states...',
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < steps.length) {
        setLogs((prev) => [...prev, `✅ ${steps[i]}`]);
        setPercent(Math.round(((i + 1) / steps.length) * 100));
        i += 1;
      } else {
        setDone(true);
        clearInterval(interval);
      }
    }, 900);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-background text-on-surface font-body">
      <section className="w-1/2 bg-inverse-surface text-inverse-on-surface flex flex-col border-r border-outline">
        <div className="px-6 py-4 flex items-center justify-between bg-black/10">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <h2 className="font-headline text-lg tracking-tight">AI Agent Console</h2>
          </div>
          <div className="flex gap-2">
            <span className="text-xs font-mono opacity-50 px-2 py-1 bg-white/5 rounded">v2.4.0-stable</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 font-mono text-sm space-y-4">
          {logs.length === 0 && <p className="text-white/40">Initializing agent...</p>}
          {logs.map((log, idx) => (
            <div key={idx} className="flex gap-3 items-start">
              <span className="material-symbols-outlined text-primary text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>
                {log.startsWith('✅') ? 'check_circle' : 'sync'}
              </span>
              <div className="space-y-1">
                <p className="text-inverse-primary">{log}</p>
                <p className="text-white/40 text-xs">{`// ${idx + 1} of ${6}`}</p>
              </div>
            </div>
          ))}

          <div className="mt-8 p-4 bg-black/20 rounded-lg border border-white/5 text-xs leading-relaxed text-white/70">
            <div className="flex items-center gap-2 mb-2 text-white/30 border-b border-white/5 pb-2">
              <span className="material-symbols-outlined text-xs">code</span>
              <span>analysis_stream.ts</span>
            </div>
            <pre className="font-mono text-xs leading-5 text-white/80">
              {`function applyTheme(themeData) {\n  const tokens = themeData.tokens;\n  tokens.forEach(token => applyToken(token));\n  console.log('Mapping', token.name, '->', token.value);\n}`}
            </pre>
          </div>
        </div>

        <div className="p-4 bg-black/10 border-t border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-white/40">
            <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">terminal</span> CLI Ready</span>
            <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">memory</span> 1.2GB RAM</span>
          </div>
          <div className="text-xs text-primary font-bold">{done ? 'AGENT COMPLETE' : 'AGENT ACTIVE'}</div>
        </div>
      </section>

      <section className="w-1/2 bg-surface-container-low flex flex-col">
        <div className="px-6 py-4 flex items-center justify-between border-b border-outline-variant bg-white/50 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-on-surface-variant">visibility</span>
            <h2 className="font-headline text-lg text-on-surface">Live Preview</h2>
          </div>
          <div className="flex items-center gap-2 bg-surface-container p-1 rounded-full border border-outline-variant">
            <button className="px-3 py-1 bg-white shadow-sm rounded-full text-xs font-bold text-primary">Desktop</button>
            <button className="px-3 py-1 text-xs font-bold text-on-surface-variant hover:text-on-surface">Mobile</button>
          </div>
        </div>

        <div className="flex-1 p-8 overflow-y-auto">
          <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm overflow-hidden border border-outline-variant min-h-full">
            <div className="p-6 border-b border-outline-variant flex justify-between items-center">
              <div className="w-32 h-6 skeleton-pulse rounded-md" />
              <div className="flex gap-4">
                <div className="w-16 h-4 skeleton-pulse rounded-md" />
                <div className="w-16 h-4 skeleton-pulse rounded-md" />
                <div className="w-16 h-4 skeleton-pulse rounded-md" />
              </div>
            </div>
            <div className="p-12 space-y-6">
              <div className="w-3/4 h-12 skeleton-pulse rounded-lg mx-auto" />
              <div className="w-full h-4 skeleton-pulse rounded-lg" />
              <div className="w-5/6 h-4 skeleton-pulse rounded-lg" />
              <div className="w-40 h-12 skeleton-pulse rounded-full mx-auto mt-8" />
            </div>
            <div className="p-12 grid grid-cols-3 gap-6">
              <div className="col-span-2 h-64 skeleton-pulse rounded-xl" />
              <div className="col-span-1 h-64 skeleton-pulse rounded-xl" />
              <div className="col-span-1 h-64 skeleton-pulse rounded-xl" />
              <div className="col-span-2 h-64 skeleton-pulse rounded-xl" />
            </div>
            <div className="p-12 bg-surface-container mt-12">
              <div className="grid grid-cols-4 gap-8">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="space-y-4">
                    <div className="w-20 h-4 skeleton-pulse rounded-md" />
                    <div className="w-full h-3 skeleton-pulse rounded-sm" />
                    <div className="w-full h-3 skeleton-pulse rounded-sm" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default SplitView;
