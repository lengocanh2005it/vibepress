import type { ComponentInfo } from "../types/inspector";

interface Props {
  info: ComponentInfo | null;
  onClear?: () => void;
}

export function InspectorPanel({ info, onClear }: Props) {
  if (!info) {
    return (
      <div className="px-5 py-4 text-sm text-[#9ca3af]">
        Click vào element trong preview để xem thông tin component.
      </div>
    );
  }

  const filePath = info.source?.file ?? null;
  const line = info.source?.line;
  const column = info.source?.column;

  const copySource = () => {
    if (!filePath) return;
    const text = line ? `${filePath}:${line}` : filePath;
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-4 text-sm">

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">
          Component Info
        </p>
        {onClear && (
          <button
            onClick={onClear}
            className="text-[11px] text-[#9ca3af] transition hover:text-[#6b7280]"
          >
            Xoá
          </button>
        )}
      </div>

      {/* Source — nổi bật nhất */}
      {filePath ? (
        <div className="rounded-[12px] bg-[#1e1e2e] px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6366f1]">
              Source
            </span>
            <button
              onClick={copySource}
              className="text-[10px] text-[#6b7280] transition hover:text-[#a5b4fc]"
            >
              copy
            </button>
          </div>
          <p className="break-all font-mono text-[12px] leading-5 text-[#a5b4fc]">
            {filePath}
          </p>
          {line && (
            <p className="mt-1 font-mono text-[11px] text-[#6b7280]">
              <span className="text-[#f59e0b]">line {line}</span>
              {column ? <span className="text-[#6b7280]">  col {column}</span> : null}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-[12px] bg-[#1e1e2e] px-4 py-2.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6366f1]">
            Source
          </span>
          <p className="mt-1 text-[11px] text-[#6b7280]">
            Không tìm thấy — element này có thể thuộc thư viện hoặc không có JSX source map.
          </p>
        </div>
      )}

      {/* Component name + tag */}
      <div className="rounded-[12px] border border-[#ede4d8] bg-[#fdfaf6] px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-[#6366f1]">{info.component}</span>
          <code className="rounded bg-[#efe7d8] px-1.5 py-0.5 text-[10px] font-bold text-[#7f6846]">
            {info.tag.toLowerCase()}
          </code>
        </div>
        {info.text && (
          <p className="mt-1.5 truncate text-[11px] text-[#9ca3af]">
            "{info.text}"
          </p>
        )}
        <p className="mt-1 text-[11px] text-[#b4ada4]">
          {info.rect.w} × {info.rect.h} px
        </p>
      </div>

      {/* Section identity */}
      {info.vpSourceNode && (
        <div className="rounded-[12px] border border-[#ede4d8] bg-[#fdfaf6] px-4 py-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b826f]">Section</span>
          <p className="mt-1.5 font-mono text-[11px] text-[#374151]">{info.vpSourceNode}</p>
          {info.vpSectionKey && (
            <p className="mt-0.5 text-[11px] text-[#6b7280]">
              key: <span className="font-semibold text-[#374151]">{info.vpSectionKey}</span>
              {info.vpComponent && (
                <span className="ml-2 text-[#9ca3af]">· {info.vpComponent}</span>
              )}
            </p>
          )}
        </div>
      )}

      {/* CSS classes */}
      {info.classes.length > 0 && (
        <div>
          <span className="text-[11px] text-[#6b7280]">Classes:</span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {info.classes.map((cls) => (
              <code
                key={cls}
                className="rounded bg-[#f3f4f6] px-1.5 py-0.5 text-[11px] text-[#374151]"
              >
                {cls}
              </code>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
