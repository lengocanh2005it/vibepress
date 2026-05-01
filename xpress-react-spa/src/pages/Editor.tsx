import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import {
  AiProcessError,
  runAiProcess,
  type AiEditRequestPayload,
} from "../services/AiService";
import {
  captureRegion,
  deleteCapturesBySite,
  getCapturesBySite,
  getWpSitePages,
  saveCapture,
} from "../services/automationService";
import type {
  ViewportCaptureRect,
  DocumentCaptureRect,
  CaptureNormalizedRect,
  Capture,
} from "../types/capture";

interface WpPage {
  id: number;
  title: string;
  slug: string;
  link: string;
  status: string;
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

type SupportedLanguage = "vi" | "en";

const stripVietnameseMarks = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");

const normalizeLanguageInput = (value?: string | null) =>
  value?.trim().toLowerCase()
    ? stripVietnameseMarks(value.trim().toLowerCase())
    : "";

const detectRequestLanguage = (
  prompt: string,
  captureNotes: string[],
): SupportedLanguage => {
  const combined = [prompt, ...captureNotes].join(" ").trim();
  const normalized = normalizeLanguageInput(combined) || "";

  if (!normalized) return "en";

  const hasVietnameseDiacritics =
    stripVietnameseMarks(combined.toLowerCase()) !== combined.toLowerCase();
  const hasVietnameseKeywords =
    /\b(hay|giup|migrate toan bo|toan bo|toan site|toan website|chuyen doi|dich chuyen|giu nguyen|dieu chinh|chinh sua|doi mau|trang chu|dau trang|chan trang|khu vuc)\b/.test(
      normalized,
    );

  return hasVietnameseDiacritics || hasVietnameseKeywords ? "vi" : "en";
};

const mentionsFocusTarget = (value: string) =>
  /\b(home|homepage|landing|about|contact|blog|header|hero|footer|navbar|section|page|trang chu|trang home|trang gioi thieu|trang lien he|dau trang|chan trang|khu vuc)\b/.test(
    value,
  );

const hasConcreteEditAction = (value: string) =>
  /\b(make|change|update|adjust|reduce|increase|move|align|center|replace|remove|add|keep|preserve|match|use|switch|resize|shrink|expand|hide|show|simplify|restyle|redesign|improve|fix|doi|sua|chinh sua|dieu chinh|giam|tang|can giua|can trai|can phai|thay|xoa|them|giu|bao toan|khop|dung|chuyen|thu nho|mo rong|an|hien|toi uu|lam nho|lam lon)\b/.test(
    value,
  );

const detectUnsupportedEditRequestReason = (value: string) => {
  const normalized = normalizeLanguageInput(value) || "";
  if (!normalized) return undefined;

  if (
    /\b(add|insert|create|introduce|implement|them|chen|tao moi|bo sung)\b/.test(
      normalized,
    ) &&
    /\b(section|component|widget|feature|module|carousel|slider|modal|popup|tabs|accordion|faq|newsletter|form|chat|chatbot)\b/.test(
      normalized,
    )
  ) {
    return "add-section-or-component";
  }

  if (
    /\b(replace|convert|switch|swap|thay the|doi thanh|chuyen thanh)\b/.test(
      normalized,
    ) &&
    /\b(section|component|widget|layout block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(
      normalized,
    )
  ) {
    return "replace-section-or-component";
  }

  if (
    /\b(remove|delete|drop|xoa|bo)\b/.test(normalized) &&
    /\b(section|component|widget|block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(
      normalized,
    )
  ) {
    return "remove-section-or-component";
  }

  if (
    /\b(font|typography|font-size|text size|line-height|letter-spacing|font weight|chu|co chu)\b/.test(
      normalized,
    )
  ) {
    return "typography-change";
  }

  return undefined;
};

const isGenericCapturePhrase = (value: string) =>
  [
    "home page",
    "homepage",
    "trang home",
    "trang chu",
    "header",
    "hero",
    "footer",
    "section nay",
    "khu vuc nay",
    "cho nay",
    "cai nay",
    "lam dep hon",
    "dep hon",
    "fix giup",
    "sua giup",
    "change this",
    "fix this",
    "make it better",
    "improve this",
    "same here",
  ].includes(value);

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const roundNumber = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toRoutePath = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    const route = new URL(value).pathname.replace(/\/+$/g, "");
    return route || "/";
  } catch {
    const cleaned = value.trim().replace(/\/+$/g, "");
    return cleaned || "/";
  }
};

const resolveWordPressRoute = (
  route?: string | null,
  pageUrl?: string | null,
): string | null => {
  if (route && !route.startsWith("/api/wp/proxy")) {
    return route;
  }

  return toRoutePath(pageUrl);
};

const buildPreviewProxyUrl = (
  pageUrl?: string | null,
  siteId?: string | null,
  previewVersion?: number,
) => {
  if (!pageUrl) return "";

  const params = new URLSearchParams({
    url: pageUrl,
  });

  if (siteId) {
    params.set("siteId", siteId);
  }

  if (typeof previewVersion === "number") {
    params.set("vpv", String(previewVersion));
  }

  return `/api/wp/proxy?${params.toString()}`;
};


const EDITOR_MESSAGES: Record<
  | "mainPromptNotAllowedWithCaptures"
  | "captureNoteRequired"
  | "captureNoteTooVague"
  | "captureNoteTooVagueOnSave"
  | "supplementalPromptTooVague"
  | "supplementalPromptTargetRequired"
  | "mainPromptRequired"
  | "focusTargetActionRequired"
  | "unclearIntent"
  | "saveCaptureNoteRequired"
  | "selectedCaptureNoteRequired"
  | "requestWillUseInference"
  | "captureWillUseInferenceOnSave"
  | "selectedCapturesWillUseInference"
  | "pipelineStartFailed"
  | "unsupportedEditOperation"
  | "outOfScope"
  | "invalidEditRequest",
  Record<SupportedLanguage, string>
> = {
  mainPromptNotAllowedWithCaptures: {
    vi: "Khi đã đính kèm capture, hãy dùng note trên từng capture thay vì prompt chính.",
    en: "When captures are attached, use the note on each capture instead of the main prompt.",
  },
  captureNoteRequired: {
    vi: "Mỗi capture đính kèm cần có một yêu cầu chỉnh sửa rõ ràng trước khi gửi cho AI.",
    en: "Each attached capture needs a clear edit request before sending to AI.",
  },
  captureNoteTooVague: {
    vi: "Note của capture phải mô tả thay đổi UI cụ thể, không chỉ ghi chung chung như Home, header hoặc fix this.",
    en: "Each capture note must describe a concrete UI change, not just a generic label like Home, header, or fix this.",
  },
  captureNoteTooVagueOnSave: {
    vi: 'Chưa thể lưu capture này. Hãy ghi rõ thay đổi cần làm, ví dụ: "Giảm chiều cao hero" hoặc "Đổi màu CTA sang xanh".',
    en: 'This capture cannot be saved yet. Describe the requested change clearly, for example: "Reduce hero height" or "Change the CTA to green".',
  },
  supplementalPromptTooVague: {
    vi: 'Khi đã có capture, prompt chính vẫn phải là một chỉ dẫn rõ ràng. Các nội dung như "hello" hoặc "test" sẽ bị chặn.',
    en: 'When captures are attached, the main prompt must still be a clear additional instruction. Inputs like "hello" or "test" are rejected.',
  },
  supplementalPromptTargetRequired: {
    vi: "Khi đã có capture, prompt chính chỉ nên bổ sung ngữ cảnh cho đúng page hoặc khu vực và vẫn phải nằm trong 4 nhóm: nội dung, background, color, layout.",
    en: "When captures are attached, keep the main prompt tied to a specific page or area and limit it to content, background, color, or layout changes.",
  },
  mainPromptRequired: {
    vi: "Hãy nhập một yêu cầu migrate rõ ràng. Nếu kèm chỉnh sửa, chỉ dùng 4 nhóm: nội dung, background, color hoặc layout.",
    en: "Add a clear migration prompt. Any requested edit must stay within content, background, color, or layout changes.",
  },
  focusTargetActionRequired: {
    vi: "Nếu bạn nhắc đến một page như Home, hãy nói rõ phần nào trên đó cần thay đổi và thay đổi đó phải thuộc content, background, color hoặc layout.",
    en: "When you mention a page like Home, also describe what should change there, limited to content, background, color, or layout.",
  },
  unclearIntent: {
    vi: "Hãy mô tả yêu cầu migrate toàn site, hoặc một chỉnh sửa rõ ràng trên page/khu vực cụ thể thuộc 4 nhóm: nội dung, background, color, layout.",
    en: "Describe either the full-site migration or a clear page-level edit limited to content, background, color, or layout.",
  },
  saveCaptureNoteRequired: {
    vi: "Hãy thêm một yêu cầu chỉnh sửa rõ ràng trước khi lưu capture này.",
    en: "Add a clear edit request before saving this capture.",
  },
  selectedCaptureNoteRequired: {
    vi: "Mỗi capture đã chọn cần có note yêu cầu chỉnh sửa trước khi thêm vào chat.",
    en: "Each selected capture needs an edit request before it can be added to chat.",
  },
  requestWillUseInference: {
    vi: "Yêu cầu chưa thật rõ, nhưng vẫn sẽ được gửi. AI sẽ tự suy luận thêm từ prompt, page context và captures.",
    en: "The request is still ambiguous, but it will be sent. AI will infer the missing detail from the prompt, page context, and captures.",
  },
  captureWillUseInferenceOnSave: {
    vi: "Capture này vẫn được lưu dù note chưa cụ thể. AI sẽ dựa thêm vào vùng chọn, DOM context và screenshot để suy luận.",
    en: "This capture will still be saved even though the note is not very specific. AI will infer more from the selection, DOM context, and screenshot.",
  },
  selectedCapturesWillUseInference: {
    vi: "Các capture đã chọn vẫn được thêm vào chat dù note chưa đủ rõ. AI sẽ xử lý theo cơ chế suy luận tốt nhất.",
    en: "The selected captures will still be added to chat even though some notes are not very specific. AI will handle them with best-effort inference.",
  },
  pipelineStartFailed: {
    vi: "Không thể khởi chạy AI pipeline.",
    en: "Failed to start AI pipeline.",
  },
  unsupportedEditOperation: {
    vi: "Luồng edit hiện chỉ hỗ trợ 4 nhóm thay đổi: đổi nội dung, đổi background, đổi color, hoặc đổi layout. Các yêu cầu thêm/xóa/thay section, thêm feature mới, hoặc đổi typography hiện chưa được hỗ trợ.",
    en: "The current edit flow only supports content, background, color, or layout changes. Adding/removing/replacing sections, adding new features, or typography-only edits are not supported.",
  },
  outOfScope: {
    vi: "Yêu cầu này không giống một tác vụ migrate site hoặc một chỉnh sửa UI thuộc 4 nhóm được hỗ trợ.",
    en: "This prompt does not look like a site migration or a supported UI edit.",
  },
  invalidEditRequest: {
    vi: "Không thể hiểu yêu cầu này như một chỉ dẫn migrate hoặc chỉnh sửa hợp lệ trong 4 nhóm được hỗ trợ.",
    en: "The request could not be understood as a valid migration instruction or a supported edit request.",
  },
};

const getEditorMessage = (
  language: SupportedLanguage,
  key: keyof typeof EDITOR_MESSAGES,
) => EDITOR_MESSAGES[key][language];

const getAiErrorMessage = (
  error: AiProcessError,
  language: SupportedLanguage,
) => {
  const messageByCode: Partial<Record<string, keyof typeof EDITOR_MESSAGES>> = {
    MAIN_PROMPT_REQUIRED: "mainPromptRequired",
    MAIN_PROMPT_NOT_ALLOWED_WITH_CAPTURES: "mainPromptNotAllowedWithCaptures",
    SUPPLEMENTAL_PROMPT_TOO_VAGUE: "supplementalPromptTooVague",
    SUPPLEMENTAL_PROMPT_TARGET_REQUIRED: "supplementalPromptTargetRequired",
    CAPTURE_NOTE_REQUIRED: "captureNoteRequired",
    CAPTURE_NOTE_TOO_VAGUE: "captureNoteTooVague",
    FOCUS_TARGET_ACTION_REQUIRED: "focusTargetActionRequired",
    UNSUPPORTED_EDIT_OPERATION: "unsupportedEditOperation",
    UNCLEAR_INTENT: "unclearIntent",
    OUT_OF_SCOPE: "outOfScope",
    INVALID_EDIT_REQUEST: "invalidEditRequest",
  };

  const mappedKey = error.code ? messageByCode[error.code] : undefined;
  if (mappedKey) {
    return getEditorMessage(language, mappedKey);
  }

  return error.message || getEditorMessage(language, "pipelineStartFailed");
};

const getChatHelperContent = (
  language: SupportedLanguage,
  isCaptureMode: boolean,
) => {
  if (isCaptureMode) {
    return language === "vi"
      ? {
          title: "Supported edit scope",
          body: 'Mỗi capture nên mô tả một thay đổi cụ thể thuộc 1 trong 4 nhóm: nội dung, background, color hoặc layout. Ví dụ: "Đổi nền section này sang xanh nhạt" hoặc "Giảm khoảng cách giữa 2 cột".',
        }
      : {
          title: "Supported edit scope",
          body: 'Each capture should describe one concrete change within the 4 supported groups: content, background, color, or layout. Example: "Change this section background to light green" or "Reduce the gap between these two columns".',
        };
  }

  return language === "vi"
    ? {
        title: "Main prompt",
        body: 'Hãy mô tả migrate toàn site. Nếu muốn kèm chỉnh sửa, chỉ yêu cầu content/background/color/layout. Ví dụ: "Migrate toàn bộ site sang React và đổi nền hero ở trang Home sang xanh nhạt".',
      }
    : {
        title: "Main prompt",
        body: 'Describe the full-site migration. If you also want edits, keep them limited to content, background, color, or layout. Example: "Migrate the full site to React and change the hero background on the Home page to light green".',
      };
};

const getChatInputPlaceholder = (language: SupportedLanguage) =>
  language === "vi"
    ? "Mô tả migrate hoặc chỉnh sửa thuộc content/background/color/layout..."
    : "Describe the migration or any content/background/color/layout edit...";

const Editor: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const siteUrl: string = location.state?.siteUrl || "";
  const siteId: string = location.state?.siteId || "";

  const [sitePagesOpen, setSitePagesOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [wpPages, setWpPages] = useState<WpPage[]>([]);
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>(siteUrl);

  // Capture states
  const [isCapturing, setIsCapturing] = useState(false);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [captureComment, setCaptureComment] = useState("");
  const [showCommentPopup, setShowCommentPopup] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<string[]>([]);
  const [chatCaptures, setChatCaptures] = useState<Capture[]>([]);
  const [previewCapture, setPreviewCapture] = useState<Capture | null>(null);
  const [isSubmittingCapture, setIsSubmittingCapture] = useState(false);
  const [isSendingAiRequest, setIsSendingAiRequest] = useState(false);
  const [capturesOpen, setCapturesOpen] = useState(true);
  const previewVersionRef = useRef(Date.now());
  const [rightTab, setRightTab] = useState<"captures" | "notes">("captures");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [annotations, setAnnotations] = useState<Annotation[]>([
    {
      id: 1,
      targetId: "block-1",
      author: "John Doe",
      time: "10 minutes ago",
      content:
        "Reduce the top padding in this header and center the navigation items a bit more cleanly.",
      initials: "JD",
      colorClasses: "bg-[#d2dacb] text-[#49704F]",
    },
    {
      id: 2,
      targetId: "block-2",
      author: "Sarah Miller",
      time: "2 hours ago",
      content:
        "Change the subheader color to a darker green and add a little more spacing below each one.",
      initials: "SM",
      colorClasses: "bg-[#e8d5a1]/40 text-[#7a5e18]",
    },
    {
      id: 3,
      targetId: "block-3",
      author: "Alex Kim",
      time: "Yesterday",
      content:
        "This area feels too heavy. Lighten the background and tighten the spacing so it matches the rest of the page.",
      initials: "AK",
      colorClasses: "bg-[#f0eede] text-[#8e9892]",
    },
  ]);

  useEffect(() => {
    if (!siteId) return;
    const load = async () => {
      const listCaptures = await getCapturesBySite(siteId);
      setCaptures(listCaptures);
    };
    load();
  }, [siteId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (isTypingTarget) return;

      if (event.key === "ArrowRight") {
        navigate("/app/editor/split-view", { state: { siteId } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, siteId]);

  useEffect(() => {
    if (!siteUrl) return;
    getWpSitePages(siteUrl)
      .then(setWpPages)
      .catch(() => setWpPages([]));
  }, [siteUrl]);

  const showToast = (
    message: string,
    tone: "error" | "success" | "warning" = "error",
  ) => {
    const fn =
      tone === "success"
        ? toast.success
        : tone === "warning"
          ? toast.warn
          : toast.error;
    fn(message, {
      position: "top-right",
      autoClose: 4000,
      hideProgressBar: true,
      closeButton: false,
      className:
        tone === "success"
          ? "!rounded-2xl !border !border-[#cfe0c5] !bg-[#f4fbef] !px-4 !py-3 !text-[13px] !font-medium !text-[#3e6a39] !shadow-lg"
          : tone === "warning"
            ? "!rounded-2xl !border !border-[#ead9a4] !bg-[#fff9ea] !px-4 !py-3 !text-[13px] !font-medium !text-[#8a6a12] !shadow-lg"
            : "!rounded-2xl !border !border-[#e2beb9] !bg-[#fff4f2] !px-4 !py-3 !text-[13px] !font-medium !text-[#8c413a] !shadow-lg",
    });
  };

  const cancelCaptureFlow = () => {
    setIsCapturing(false);
    setSelection(null);
    setShowCommentPopup(false);
    setCaptureComment("");
    setIsDragging(false);
  };

  useEffect(() => {
    if (!isCapturing && !showCommentPopup) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelCaptureFlow();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCapturing, showCommentPopup]);

  const getCaptureDisplayUrl = (capture: Capture) =>
    capture.asset?.url ||
    `${import.meta.env.VITE_BACKEND_URL}${capture.filePath}`;

  const getCaptureMimeType = (
    capture: Capture,
  ): "image/png" | "image/jpeg" | "image/webp" => {
    const mimeType = capture.asset?.mimeType;
    if (
      mimeType === "image/png" ||
      mimeType === "image/jpeg" ||
      mimeType === "image/webp"
    ) {
      return mimeType;
    }
    return "image/png";
  };

  const isMeaningfulNoCapturePrompt = (value: string) => {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
    const normalizedAscii = normalized
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D");
    if (normalized.length < 12) return false;
    if (
      [
        "hello",
        "hi",
        "test",
        "ok",
        "oke",
        "fix this",
        "change this",
        "xin chao",
        "chao",
        "thu",
        "sua cai nay",
        "doi cai nay",
      ].includes(normalizedAscii)
    ) {
      return false;
    }

    const migrationSignal =
      /\b(migrate|migration|convert|rebuild|clone|port|transform|chuyen doi|migrate full|migrate toan bo|di chuyen sang react)\b/.test(
        normalizedAscii,
      );
    const uiSignal =
      /\b(improve|update|adjust|refine|redesign|restyle|focus|preserve|change|make|toi uu|dieu chinh|chinh sua|giu nguyen|doi mau|tap trung)\b/.test(
        normalizedAscii,
      );
    const scopeSignal =
      /\b(site|website|wordpress|theme|all pages|full site|whole site|entire site|toan bo|ca trang|toan site|toan website)\b/.test(
        normalizedAscii,
      );
    const focusSignal =
      /\b(home|homepage|landing|about|contact|blog|header|hero|footer|navbar|section|page|trang chu|trang home|trang gioi thieu|trang lien he|dau trang|chan trang|khu vuc)\b/.test(
        normalizedAscii,
      );

    return (
      migrationSignal ||
      (uiSignal && (scopeSignal || focusSignal))
    );
  };

  const hasFocusTargetWithoutAction = (value: string) => {
    const normalized = normalizeLanguageInput(value) || "";
    return (
      mentionsFocusTarget(normalized) && !hasConcreteEditAction(normalized)
    );
  };

  const isSpecificCaptureNote = (value: string) => {
    const normalized = normalizeLanguageInput(value) || "";
    if (!normalized || normalized.length < 6) return false;
    if (isGenericCapturePhrase(normalized)) return false;
    return hasConcreteEditAction(normalized);
  };

  const isMeaningfulSupplementalPrompt = (value: string) => {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
    const normalizedAscii = normalizeLanguageInput(normalized) || "";

    if (normalized.length < 6) return false;
    if (
      ["hello", "hi", "test", "ok", "oke", "xin chao", "chao", "thu"].includes(
        normalizedAscii,
      )
    ) {
      return false;
    }

    return (
      hasConcreteEditAction(normalizedAscii) ||
      mentionsFocusTarget(normalizedAscii)
    );
  };

  const collectInferenceWarnings = (
    prompt: string,
    capturesForAi: Capture[],
    language: SupportedLanguage,
  ) => {
    const warnings: string[] = [];

    if (capturesForAi.length > 0) {
      if (prompt && !isMeaningfulSupplementalPrompt(prompt)) {
        warnings.push(
          getEditorMessage(language, "supplementalPromptTooVague"),
        );
      }
      if (capturesForAi.some((capture) => !capture.comment.trim())) {
        warnings.push(getEditorMessage(language, "captureNoteRequired"));
      }
      if (
        capturesForAi.some((capture) => capture.comment.trim()) &&
        capturesForAi.some((capture) => !isSpecificCaptureNote(capture.comment))
      ) {
        warnings.push(getEditorMessage(language, "captureNoteTooVague"));
      }
    } else {
      if (prompt && !isMeaningfulNoCapturePrompt(prompt)) {
        warnings.push(getEditorMessage(language, "unclearIntent"));
      }
      if (prompt && hasFocusTargetWithoutAction(prompt)) {
        warnings.push(
          getEditorMessage(language, "focusTargetActionRequired"),
        );
      }
    }

    return warnings;
  };

  const buildAiAttachmentPayload = (capture: Capture) => ({
    id: capture.id,
    note: capture.comment,
    sourcePageUrl: capture.pageUrl,
    captureContext: {
      capturedAt: capture.capturedAt,
      iframeSrc: capture.iframeSrc,
      viewport: capture.viewport,
      page: {
        url: capture.pageUrl,
        route: resolveWordPressRoute(capture.page.route, capture.pageUrl),
        title: capture.page.title,
      },
      document: {
        width: capture.page.documentWidth,
        height: capture.page.documentHeight,
      },
    },
    selection: capture.selection,
    geometry: capture.geometry,
    asset: {
      provider: capture.asset?.provider || "local",
      fileName:
        capture.asset?.fileName ||
        capture.fileName ||
        capture.filePath.split("/").pop() ||
        `${capture.id}.png`,
      publicUrl: getCaptureDisplayUrl(capture),
      mimeType: getCaptureMimeType(capture),
      width: capture.asset?.width,
      height: capture.asset?.height,
    },
  });

  const buildAiRequestPayload = (
    prompt: string,
    language: SupportedLanguage,
    capturesForAi: Capture[],
  ) => {
    const primaryPage = capturesForAi[0]?.page;
    const primaryCapture = capturesForAi[0];

    return {
      ...(prompt ? { prompt } : {}),
      language,
      pageContext: {
        wordpressUrl: selectedPageUrl,
        wordpressRoute:
          resolveWordPressRoute(primaryPage?.route, selectedPageUrl) ||
          toRoutePath(selectedPageUrl),
        iframeSrc: primaryCapture?.iframeSrc,
        pageTitle:
          primaryPage?.title ||
          wpPages
            .find((page) => page.link === selectedPageUrl)
            ?.title?.trim() ||
          undefined,
        viewport: primaryCapture?.viewport,
        document: primaryPage
          ? {
              width: primaryPage.documentWidth,
              height: primaryPage.documentHeight,
            }
          : undefined,
      },
      ...(capturesForAi.length > 0
        ? {
            attachments: capturesForAi.map(buildAiAttachmentPayload),
          }
        : {}),
    };
  };

  const hasUnsupportedEditRequest = (
    prompt: string,
    capturesForAi: Capture[],
  ) =>
    detectUnsupportedEditRequestReason(
      [prompt, ...capturesForAi.map((capture) => capture.comment || "")]
        .filter(Boolean)
        .join("\n"),
    );

  const sendChatMessage = async () => {
    const trimmedPrompt = chatInput.trim();
    const hasCaptureInstructions = chatCaptures.length > 0;
    const requestLanguage = detectRequestLanguage(
      trimmedPrompt,
      chatCaptures.map((capture) => capture.comment),
    );

    if (!siteId) return;

    if (!hasCaptureInstructions && !trimmedPrompt) {
      showToast(getEditorMessage(requestLanguage, "mainPromptRequired"));
      return;
    }

    if (hasUnsupportedEditRequest(trimmedPrompt, chatCaptures)) {
      showToast(getEditorMessage(requestLanguage, "unsupportedEditOperation"));
      return;
    }

    const inferenceWarnings = collectInferenceWarnings(
      trimmedPrompt,
      chatCaptures,
      requestLanguage,
    );
    if (inferenceWarnings.length > 0) {
      showToast(
        `${getEditorMessage(requestLanguage, "requestWillUseInference")} ${inferenceWarnings[0]}`,
        "warning",
      );
    }

    setIsSendingAiRequest(true);

    const requestBody: AiEditRequestPayload = buildAiRequestPayload(
      trimmedPrompt,
      requestLanguage,
      chatCaptures,
    );

    console.log("Sending AI request with body:", requestBody);
    try {
      const data = await runAiProcess(siteId, requestBody);

      setChatInput("");
      setChatCaptures([]);
      console.log("AI process started with job ID:", data.jobId);
      await deleteCapturesBySite(siteId);
      navigate("/app/editor/split-view", {
        state: { jobId: data.jobId, siteId, editRequest: requestBody },
      });
    } catch (error) {
      if (error instanceof AiProcessError) {
        showToast(getAiErrorMessage(error, requestLanguage));
      } else {
        showToast(getEditorMessage(requestLanguage, "pipelineStartFailed"));
      }
    } finally {
      setIsSendingAiRequest(false);
    }
  };

  const handleAddComment = () => {
    if (!commentText.trim() || !activeTarget) return;
    const newId =
      annotations.length > 0
        ? Math.max(...annotations.map((a) => a.id)) + 1
        : 1;
    const newAnnotation: Annotation = {
      id: newId,
      targetId: activeTarget,
      author: "Current User",
      time: "Just now",
      content: commentText.trim(),
      initials: "CU",
      colorClasses: "bg-[#49704F] text-white",
    };
    setAnnotations([...annotations, newAnnotation]);
    setCommentText("");
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
    setSelection({
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
    });
    setIsDragging(true);
  };

  const handleOverlayMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !selection) return;
    const rect = overlayRef.current!.getBoundingClientRect();
    setSelection((s) =>
      s ? { ...s, endX: e.clientX - rect.left, endY: e.clientY - rect.top } : s,
    );
  };

  const handleOverlayMouseUp = () => {
    if (!selection) return;
    setIsDragging(false);
    const r = getRelativeRect(selection);
    if (r.width > 10 && r.height > 10) setShowCommentPopup(true);
  };

  const getCommentPopupPosition = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const popupWidth = 288;
    const popupHeight = 212;
    const margin = 12;
    const overlayWidth = Math.max(
      popupWidth + margin * 2,
      Math.round(overlayRef.current?.clientWidth || window.innerWidth),
    );
    const overlayHeight = Math.max(
      popupHeight + margin * 2,
      Math.round(overlayRef.current?.clientHeight || window.innerHeight),
    );

    const left = Math.min(
      Math.max(margin, rect.x),
      overlayWidth - popupWidth - margin,
    );

    const preferredBelow = rect.y + rect.height + 8;
    const preferredAbove = rect.y - popupHeight - 8;
    const top =
      preferredBelow + popupHeight <= overlayHeight - margin
        ? preferredBelow
        : Math.max(margin, preferredAbove);

    return {
      left,
      top: Math.min(top, overlayHeight - popupHeight - margin),
    };
  };

  const getCaptureMetrics = () => {
    const iframeEl = iframeRef.current;
    const fallbackWidth = Math.max(
      1,
      Math.round(overlayRef.current?.clientWidth || window.innerWidth),
    );
    const fallbackHeight = Math.max(
      1,
      Math.round(overlayRef.current?.clientHeight || window.innerHeight),
    );

    const fallbackRoute = toRoutePath(selectedPageUrl);
    const fallbackTitle =
      wpPages.find((page) => page.link === selectedPageUrl)?.title?.trim() ||
      undefined;

    if (!iframeEl) {
      return {
        viewport: {
          width: fallbackWidth,
          height: fallbackHeight,
          scrollX: 0,
          scrollY: 0,
          dpr: window.devicePixelRatio || 1,
        },
        overlayWidth: fallbackWidth,
        overlayHeight: fallbackHeight,
        frameDocument: undefined,
        page: {
          route: fallbackRoute,
          title: fallbackTitle,
          documentWidth: fallbackWidth,
          documentHeight: fallbackHeight,
        },
      };
    }

    try {
      const frameWindow = iframeEl.contentWindow;
      const frameDocument = frameWindow?.document;
      const docEl = frameDocument?.documentElement;
      const body = frameDocument?.body;
      const instrumentedRoute =
        docEl?.dataset.vpRoute || toRoutePath(selectedPageUrl);
      const viewport = {
        width: Math.max(
          1,
          Math.round(
            docEl?.clientWidth || frameWindow?.innerWidth || fallbackWidth,
          ),
        ),
        height: Math.max(
          1,
          Math.round(
            docEl?.clientHeight || frameWindow?.innerHeight || fallbackHeight,
          ),
        ),
        scrollX: Math.max(0, Math.round(frameWindow?.scrollX || 0)),
        scrollY: Math.max(0, Math.round(frameWindow?.scrollY || 0)),
        dpr: Math.max(
          1,
          frameWindow?.devicePixelRatio || window.devicePixelRatio || 1,
        ),
      };

      return {
        viewport,
        overlayWidth: Math.max(
          1,
          Math.round(
            overlayRef.current?.clientWidth ||
              iframeEl.clientWidth ||
              viewport.width,
          ),
        ),
        overlayHeight: Math.max(
          1,
          Math.round(
            overlayRef.current?.clientHeight ||
              iframeEl.clientHeight ||
              viewport.height,
          ),
        ),
        frameDocument,
        page: {
          route: instrumentedRoute || fallbackRoute,
          title: frameDocument?.title?.trim() || fallbackTitle,
          documentWidth: Math.max(
            viewport.width,
            Math.round(
              docEl?.scrollWidth ||
                body?.scrollWidth ||
                docEl?.clientWidth ||
                body?.clientWidth ||
                fallbackWidth,
            ),
          ),
          documentHeight: Math.max(
            viewport.height,
            Math.round(
              docEl?.scrollHeight ||
                body?.scrollHeight ||
                docEl?.clientHeight ||
                body?.clientHeight ||
                fallbackHeight,
            ),
          ),
        },
      };
    } catch {
      return {
        viewport: {
          width: fallbackWidth,
          height: fallbackHeight,
          scrollX: 0,
          scrollY: 0,
          dpr: window.devicePixelRatio || 1,
        },
        overlayWidth: fallbackWidth,
        overlayHeight: fallbackHeight,
        frameDocument: undefined,
        page: {
          route: fallbackRoute,
          title: fallbackTitle,
          documentWidth: fallbackWidth,
          documentHeight: fallbackHeight,
        },
      };
    }
  };

  const buildCaptureSnapshot = (sel: SelectionRect) => {
    const overlayRect = getRelativeRect(sel);
    const metrics = getCaptureMetrics();
    const scaleX = metrics.viewport.width / Math.max(1, metrics.overlayWidth);
    const scaleY = metrics.viewport.height / Math.max(1, metrics.overlayHeight);
    const maxViewportWidth = Math.max(1, metrics.viewport.width);
    const maxViewportHeight = Math.max(1, metrics.viewport.height);

    const viewportRect: ViewportCaptureRect = {
      x: clampNumber(
        roundNumber(overlayRect.x * scaleX),
        0,
        maxViewportWidth - 1,
      ),
      y: clampNumber(
        roundNumber(overlayRect.y * scaleY),
        0,
        maxViewportHeight - 1,
      ),
      width: clampNumber(
        roundNumber(overlayRect.width * scaleX),
        1,
        maxViewportWidth,
      ),
      height: clampNumber(
        roundNumber(overlayRect.height * scaleY),
        1,
        maxViewportHeight,
      ),
      coordinateSpace: "iframe-viewport",
    };

    const safeViewportWidth = Math.min(
      viewportRect.width,
      maxViewportWidth - viewportRect.x,
    );
    const safeViewportHeight = Math.min(
      viewportRect.height,
      maxViewportHeight - viewportRect.y,
    );

    const normalizedViewportRect: ViewportCaptureRect = {
      ...viewportRect,
      width: Math.max(1, roundNumber(safeViewportWidth)),
      height: Math.max(1, roundNumber(safeViewportHeight)),
    };

    const documentRect: DocumentCaptureRect = {
      x: roundNumber(
        normalizedViewportRect.x + (metrics.viewport.scrollX || 0),
      ),
      y: roundNumber(
        normalizedViewportRect.y + (metrics.viewport.scrollY || 0),
      ),
      width: normalizedViewportRect.width,
      height: normalizedViewportRect.height,
      coordinateSpace: "iframe-document",
    };

    const normalizedRect: CaptureNormalizedRect = {
      x: roundNumber(
        clampNumber(
          documentRect.x / Math.max(1, metrics.page.documentWidth),
          0,
          1,
        ),
      ),
      y: roundNumber(
        clampNumber(
          documentRect.y / Math.max(1, metrics.page.documentHeight),
          0,
          1,
        ),
      ),
      width: roundNumber(
        clampNumber(
          documentRect.width / Math.max(1, metrics.page.documentWidth),
          0,
          1,
        ),
      ),
      height: roundNumber(
        clampNumber(
          documentRect.height / Math.max(1, metrics.page.documentHeight),
          0,
          1,
        ),
      ),
      coordinateSpace: "iframe-document-normalized",
    };

    return {
      viewport: metrics.viewport,
      page: metrics.page,
      selection: documentRect,
      geometry: {
        viewportRect: normalizedViewportRect,
        documentRect,
        normalizedRect,
      },
    };
  };

  const handleSaveCapture = async () => {
    if (!selection) return;
    const captureLanguage = detectRequestLanguage("", [captureComment]);
    if (detectUnsupportedEditRequestReason(captureComment)) {
      showToast(getEditorMessage(captureLanguage, "unsupportedEditOperation"));
      return;
    }
    if (!captureComment.trim() || !isSpecificCaptureNote(captureComment)) {
      showToast(
        getEditorMessage(captureLanguage, "captureWillUseInferenceOnSave"),
        "warning",
      );
    }
    setIsSubmittingCapture(true);
    try {
      const previewSrc = buildPreviewProxyUrl(selectedPageUrl, siteId);
      const captureSnapshot = buildCaptureSnapshot(selection);
      const result = await captureRegion(
        selectedPageUrl,
        previewSrc,
        {
          x: captureSnapshot.geometry.viewportRect.x,
          y: captureSnapshot.geometry.viewportRect.y,
          width: captureSnapshot.geometry.viewportRect.width,
          height: captureSnapshot.geometry.viewportRect.height,
        },
        captureComment,
        captureSnapshot.viewport,
      );
      const captureObject = {
        id: Date.now().toString(),
        filePath: result.filePath,
        fileName: result.fileName,
        asset: result.asset,
        comment: captureComment,
        pageUrl: selectedPageUrl,
        iframeSrc: previewSrc,
        capturedAt: new Date().toISOString(),
        viewport: captureSnapshot.viewport,
        page: captureSnapshot.page,
        selection: captureSnapshot.selection,
        geometry: captureSnapshot.geometry,
      };
      await saveCapture(siteId,captureObject);
      setCaptures((prev) => [captureObject, ...prev]);
    } finally {
      setIsSubmittingCapture(false);
      setShowCommentPopup(false);
      setCaptureComment("");
      setSelection(null);
      setIsCapturing(false);
    }
  };

  const toggleCaptureSelection = (captureId: string) => {
    setSelectedCaptureIds((prev) =>
      prev.includes(captureId)
        ? prev.filter((id) => id !== captureId)
        : [...prev, captureId],
    );
  };

  const handleDeleteSelectedCaptures = () => {
    if (selectedCaptureIds.length === 0) return;
    setCaptures((prev) =>
      prev.filter((capture) => !selectedCaptureIds.includes(capture.id)),
    );
    setChatCaptures((prev) =>
      prev.filter((capture) => !selectedCaptureIds.includes(capture.id)),
    );
    setSelectedCaptureIds([]);
  };

  const handleSaveCapturesToChat = () => {
    if (selectedCaptureIds.length === 0) return;

    const capturesToSave = captures.filter((capture) =>
      selectedCaptureIds.includes(capture.id),
    );

    if (capturesToSave.length === 0) return;
    const selectionLanguage = detectRequestLanguage(
      "",
      capturesToSave.map((capture) => capture.comment),
    );
    if (
      capturesToSave.some((capture) =>
        detectUnsupportedEditRequestReason(capture.comment),
      )
    ) {
      showToast(
        getEditorMessage(selectionLanguage, "unsupportedEditOperation"),
      );
      return;
    }
    if (
      capturesToSave.some(
        (capture) =>
          !capture.comment.trim() || !isSpecificCaptureNote(capture.comment),
      )
    ) {
      showToast(
        getEditorMessage(selectionLanguage, "selectedCapturesWillUseInference"),
        "warning",
      );
    }

    setChatCaptures((prev) => {
      const merged = [...prev];
      for (const capture of capturesToSave) {
        if (!merged.some((item) => item.id === capture.id)) {
          merged.push(capture);
        }
      }
      return merged;
    });

    setChatInput("");
    setIsChatOpen(true);
  };

  const handleRemoveChatCapture = (captureId: string) => {
    setChatCaptures((prev) =>
      prev.filter((capture) => capture.id !== captureId),
    );
    setSelectedCaptureIds((prev) => prev.filter((id) => id !== captureId));
  };

  const handleClearChatCaptures = () => {
    const chatCaptureIds = chatCaptures.map((capture) => capture.id);
    setChatCaptures([]);
    setSelectedCaptureIds((prev) =>
      prev.filter((id) => !chatCaptureIds.includes(id)),
    );
  };

  const handleSelectAllCaptures = () => {
    setSelectedCaptureIds(captures.map((capture) => capture.id));
  };

  const handleClearCaptureSelection = () => {
    setSelectedCaptureIds([]);
  };

  const previewSrc = selectedPageUrl
    ? buildPreviewProxyUrl(
        selectedPageUrl,
        siteId,
        previewVersionRef.current,
      )
    : "";
  const isCaptureMode = chatCaptures.length > 0;
  const helperLanguage = detectRequestLanguage(
    chatInput,
    chatCaptures.map((capture) => capture.comment),
  );
  const chatHelper = getChatHelperContent(helperLanguage, isCaptureMode);
  const chatInputPlaceholder = getChatInputPlaceholder(helperLanguage);
  const canSendChatMessage =
    !!siteId &&
    !isSendingAiRequest &&
    (isCaptureMode ? chatCaptures.length > 0 : !!chatInput.trim());

  return (
    <div className="flex flex-col h-screen bg-[#FAF7F0] font-body text-[#233227] overflow-hidden">
      <ToastContainer
        newestOnTop
        limit={2}
        draggable={false}
        style={{ width: "min(460px, calc(100vw - 24px))" }}
        toastClassName={() => "!min-h-0 !p-0 !bg-transparent !shadow-none"}
      />

      {/* Main Work Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Sidebar: Site Pages */}
        <aside
          className={`relative shrink-0 overflow-hidden bg-[#FAF7F0] z-10 transition-[width] duration-300 ease-in-out ${sitePagesOpen ? "w-64 border-r border-[#e8e6df]" : "w-14 border-r border-[#e8e6df]"}`}
        >
          {sitePagesOpen ? (
            <div className="flex h-full w-64 flex-col transition-opacity duration-200 opacity-100">
              <div className="p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-headline text-[20px] font-bold text-[#1a2b21] mb-1">
                      Site Pages
                    </h2>
                    <p className="text-[#5c6860] text-[13px]">
                      Select a page to edit content, background, color, or layout.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSitePagesOpen(false)}
                    title="Hide site pages"
                    aria-label="Hide site pages"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      left_panel_close
                    </span>
                  </button>
                </div>
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
                          className={`rounded-2xl p-4 flex flex-col gap-2 cursor-pointer transition-colors ${isActive ? "border-2 border-[#49704F] bg-[#FAF7F0] shadow-sm" : "bg-white border border-[#e8e6df] hover:border-[#dcd9ce]"}`}
                        >
                          {isActive && (
                            <div className="self-end bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">
                              Editing
                            </div>
                          )}
                          <div className="flex items-center gap-3">
                            <span
                              className={`material-symbols-outlined text-[18px] ${isActive ? "text-[#49704F]" : "text-[#8e9892]"}`}
                            >
                              article
                            </span>
                            <span className="font-bold text-[#233227] text-[14px]">
                              {page.title}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-[#8e9892]">
                            /{page.slug}
                          </span>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <div className="bg-[#FAF7F0] border-2 border-[#49704F] rounded-2xl p-4 flex flex-col gap-2 relative shadow-sm cursor-pointer">
                      <div className="absolute top-4 right-4 bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">
                        Editing
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-[#49704F] text-[18px]">
                          home
                        </span>
                        <span className="font-bold text-[#233227] text-[14px]">
                          Home
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                        <span className="material-symbols-outlined text-[13px]">
                          history
                        </span>
                        Saved 2m ago
                      </div>
                    </div>

                    {["Blog", "About Us", "Services", "Contact"].map(
                      (page, idx) => (
                        <div
                          key={idx}
                          className="bg-white border border-[#e8e6df] rounded-2xl p-4 flex flex-col gap-2 hover:border-[#dcd9ce] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-[#8e9892] text-[18px]">
                              {page === "Blog"
                                ? "article"
                                : page === "About Us"
                                  ? "info"
                                  : page === "Services"
                                    ? "build"
                                    : "mail"}
                            </span>
                            <span className="font-bold text-[#233227] text-[14px]">
                              {page}
                            </span>
                          </div>
                          {page === "Blog" && (
                            <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                              <span className="material-symbols-outlined text-[13px]">
                                history
                              </span>{" "}
                              Updated 5h ago
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </>
                )}

                <div className="mt-4 rounded-2xl border border-dashed border-[#dcd9ce] bg-white/60 px-4 py-3 text-[12px] leading-relaxed text-[#5c6860]">
                  Pages sync from WordPress. Use captures or the chat prompt to
                  request content, background, color, or layout changes.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-14 items-start justify-center pt-6">
              <button
                type="button"
                onClick={() => setSitePagesOpen(true)}
                title="Show site pages"
                aria-label="Show site pages"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
              >
                <span className="material-symbols-outlined text-[16px]">
                  left_panel_open
                </span>
              </button>
            </div>
          )}
        </aside>

        {/* Center Canvas */}
        <main className="min-w-0 flex-1 bg-[#e8e6df]/50 flex flex-col overflow-hidden">
          <div className="w-full flex-1 relative min-h-0">
            {selectedPageUrl ? (
              <iframe
                ref={iframeRef}
                src={previewSrc}
                className="w-full h-full border-none"
                title="Site Preview"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-[#8e9892] text-sm">
                No site URL found. Select a page from the Project Selector.
              </div>
            )}

            {/* Capture overlay */}
            {isCapturing && (
              <div
                ref={overlayRef}
                className="absolute inset-0 z-30"
                style={{ cursor: "crosshair", background: "rgba(0,0,0,0.15)" }}
                onMouseDown={handleOverlayMouseDown}
                onMouseMove={handleOverlayMouseMove}
                onMouseUp={handleOverlayMouseUp}
              >
                {selection &&
                  (() => {
                    const r = getRelativeRect(selection);
                    return (
                      <div
                        className="absolute border-2 border-[#49704F] bg-[#49704F]/10"
                        style={{
                          left: r.x,
                          top: r.y,
                          width: r.width,
                          height: r.height,
                          pointerEvents: "none",
                        }}
                      />
                    );
                  })()}
              </div>
            )}

            {/* Comment popup after capture */}
            {showCommentPopup &&
              selection &&
              (() => {
                const r = getRelativeRect(selection);
                const popupPosition = getCommentPopupPosition(r);
                return (
                  <div
                    className="absolute z-40 bg-white rounded-2xl shadow-xl border border-[#e8e6df] p-4 w-72"
                    style={{
                      left: popupPosition.left,
                      top: popupPosition.top,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-[13px] font-bold text-[#233227] mb-2">
                      Describe the change for this area
                    </p>
                    <p className="mb-2 text-[12px] leading-relaxed text-[#667062]">
                      Supported scope: content, background, color, or layout
                      only.
                    </p>
                    <textarea
                      autoFocus
                      value={captureComment}
                      onChange={(e) => setCaptureComment(e.target.value)}
                      placeholder="Example: Change this section background to light green"
                      className="w-full border border-[#e8e6df] rounded-xl p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={cancelCaptureFlow}
                        className="text-[#5c6860] text-[12px] font-bold px-3 py-1.5 rounded-lg hover:bg-[#e8e6df]/50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveCapture}
                        disabled={isSubmittingCapture || !captureComment.trim()}
                        className="bg-[#49704F] disabled:opacity-50 text-white text-[12px] font-bold px-4 py-1.5 rounded-lg hover:bg-[#346E56]"
                      >
                        {isSubmittingCapture ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                );
              })()}
          </div>

          {/* Floating chat button + panel */}
          {!previewCapture && (
            <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3 pointer-events-none">
              {isChatOpen && (
                <div className="flex max-h-[70vh] w-[380px] max-w-[calc(100vw-48px)] min-h-0 flex-col overflow-hidden rounded-3xl border border-[#d8ddd4] bg-white pointer-events-auto">
                  <div className="shrink-0 p-3 border-b border-[#e5e8df]">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <h3 className="font-semibold text-sm text-[#2e3e2f]">
                        Live Chat
                      </h3>
                    </div>
                  </div>

                  {chatCaptures.length > 0 && (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                      <div className="mb-3 shrink-0 flex items-center justify-between gap-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6d7d68]">
                          Attached Captures
                        </p>
                        <button
                          type="button"
                          onClick={handleClearChatCaptures}
                          className="text-[11px] font-bold text-[#7a836f] hover:text-[#233227] transition-colors"
                        >
                          Clear all
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="grid grid-cols-2 items-start gap-3">
                          {chatCaptures.map((capture) => (
                            <div
                              key={capture.id}
                              className="relative min-w-0 overflow-hidden rounded-2xl border border-[#d9e3d1] bg-white"
                            >
                              <button
                                type="button"
                                onClick={() => setPreviewCapture(capture)}
                                className="block w-full text-left"
                              >
                                <div className="flex h-20 items-center justify-center bg-[#f7f4ec] p-2">
                                  <img
                                    src={getCaptureDisplayUrl(capture)}
                                    alt="chat capture"
                                    className="block h-full w-full rounded-xl border border-[#ebe5d7] bg-white object-contain"
                                  />
                                </div>
                                <div className="px-2 py-2">
                                  <p
                                    className="overflow-hidden text-[11px] leading-relaxed text-[#556255]"
                                    style={{
                                      display: "-webkit-box",
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: "vertical",
                                    }}
                                  >
                                    {capture.comment || "No edit request"}
                                  </p>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleRemoveChatCapture(capture.id)
                                }
                                className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[#d9d1c3] bg-white/95 text-[#6c7466] hover:text-[#233227] transition-colors"
                                aria-label="Remove attached capture"
                              >
                                <span className="material-symbols-outlined text-[14px]">
                                  close
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {chatCaptures.length === 0 && (
                    <div className="shrink-0 border-t border-[#e5e8df] bg-[#fcfbf7] px-3 py-3">
                      <p className="text-[12px] leading-relaxed text-[#6b7568]">
                        No captures attached yet. Save a selection from the
                        preview to send visual context for content, background,
                        color, or layout edits.
                      </p>
                    </div>
                  )}

                  <div className="shrink-0 p-3 border-t border-[#e5e8df]">
                    <div>
                      <div className="flex gap-2 items-center">
                        <input
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && canSendChatMessage)
                              void sendChatMessage();
                          }}
                          className="flex-1 h-10 text-sm border border-[#ccd7cc] rounded-full px-4 outline-none focus:ring-2 focus:ring-[#4a7c59]/40"
                          placeholder={chatInputPlaceholder}
                        />
                      </div>
                      <div
                        className={`mt-2 rounded-2xl px-4 py-3 ${isCaptureMode ? "border border-[#e7e2d6] bg-[#fcfaf5]" : "border border-[#ece6da] bg-[#fcfbf7]"}`}
                      >
                        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#7b876f]">
                          {chatHelper.title}
                        </p>
                        <p
                          className={`mt-1 text-[12px] leading-relaxed ${isCaptureMode ? "text-[#60705d]" : "text-[#667062]"}`}
                        >
                          {chatHelper.body}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={() => void sendChatMessage()}
                        disabled={!canSendChatMessage}
                        className="h-10 w-10 rounded-full bg-primary disabled:opacity-50 text-white flex items-center justify-center hover:bg-[#356944] transition-colors"
                      >
                        <span className="material-symbols-outlined">
                          {isSendingAiRequest ? "progress_activity" : "send"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => setIsChatOpen((prev) => !prev)}
                className="pointer-events-auto h-12 px-4 rounded-full bg-[#49704F] text-white flex items-center gap-2 hover:bg-[#346E56] transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isChatOpen ? "close" : "auto_awesome"}
                </span>
                <span className="text-[12px] font-bold">
                  {isChatOpen ? "Close chat" : "Open AI chat"}
                </span>
              </button>
            </div>
          )}
        </main>

        {/* Right Sidebar: Captures + Notes tabs */}
        <aside
          className={`relative shrink-0 overflow-hidden bg-[#FAF7F0] z-10 transition-[width] duration-300 ease-in-out ${capturesOpen ? "w-[360px] border-l border-[#e8e6df]" : "w-14 border-l border-[#e8e6df]"}`}
        >
          {capturesOpen ? (
            <div className="flex h-full w-[360px] flex-col transition-opacity duration-200 opacity-100">
              {/* Tab header */}
              <div className="shrink-0 flex items-center border-b border-[#e8e6df] bg-[#FAF7F0]">
                <button
                  type="button"
                  onClick={() => setRightTab("captures")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[13px] font-bold border-b-2 transition-colors ${rightTab === "captures" ? "border-[#49704F] text-[#49704F]" : "border-transparent text-[#8e9892] hover:text-[#233227]"}`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    crop
                  </span>
                  Capture
                  {captures.length > 0 && (
                    <span className="bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                      {captures.length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("notes")}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[13px] font-bold border-b-2 transition-colors ${rightTab === "notes" ? "border-[#49704F] text-[#49704F]" : "border-transparent text-[#8e9892] hover:text-[#233227]"}`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    comment_bank
                  </span>
                  Notes
                  {annotations.length > 0 && (
                    <span className="bg-[#e8d5a1] text-[#7a5e18] text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                      {annotations.length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setCapturesOpen(false)}
                  title="Hide panel"
                  className="flex h-9 w-9 shrink-0 items-center justify-center mr-2 rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    right_panel_close
                  </span>
                </button>
              </div>

              {/* Captures tab — header action */}
              {rightTab === "captures" && (
                <div className="shrink-0 px-4 py-3 border-b border-[#e8e6df] flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isCapturing || showCommentPopup) {
                        cancelCaptureFlow();
                      } else {
                        setIsCapturing(true);
                      }
                    }}
                    className={`text-[12px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-colors ${isCapturing ? "bg-red-500 text-white" : "bg-[#49704F] text-white hover:bg-[#346E56]"}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      {isCapturing ? "close" : "crop"}
                    </span>
                    {isCapturing ? "Cancel" : "New Capture"}
                  </button>
                  {selectedCaptureIds.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleSaveCapturesToChat}
                        className="inline-flex items-center gap-1 rounded-full border border-[#cfe0c5] bg-white px-2.5 py-1 text-[11px] font-bold text-[#49704F] hover:bg-[#f3f8ef]"
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          forum
                        </span>
                        Add to Chat
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteSelectedCaptures}
                        className="inline-flex items-center gap-1 rounded-full border border-[#e3c3bc] bg-white px-2.5 py-1 text-[11px] font-bold text-[#a94f46] hover:bg-[#fbf2f0]"
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          delete
                        </span>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Captures tab content */}
              {rightTab === "captures" && (
                <div className="flex-1 overflow-y-auto min-h-0">
                  {captures.length > 0 ? (
                    <div className="px-4 py-4 space-y-4">
                      {captures.length > 1 && (
                        <div className="flex justify-end">
                          {selectedCaptureIds.length < captures.length ? (
                            <button
                              type="button"
                              onClick={handleSelectAllCaptures}
                              className="text-[12px] font-bold text-[#49704F] hover:text-[#2f5840]"
                            >
                              Select all
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={handleClearCaptureSelection}
                              className="text-[12px] font-bold text-[#7a836f] hover:text-[#233227]"
                            >
                              Clear selection
                            </button>
                          )}
                        </div>
                      )}
                      {captures.map((cap) => (
                        <div
                          key={cap.id}
                          className={`relative overflow-hidden rounded-[24px] border bg-white transition-colors ${selectedCaptureIds.includes(cap.id) ? "border-[#cfd7cb] bg-[#fcfdfb]" : "border-[#e4e0d4]"}`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleCaptureSelection(cap.id)}
                            className={`absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${selectedCaptureIds.includes(cap.id) ? "border-[#49704F] bg-[#49704F] text-white" : "border-[#d9d4c7] bg-white/95 text-transparent hover:border-[#49704F]"}`}
                          >
                            <span className="material-symbols-outlined text-[16px]">
                              check
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setPreviewCapture(cap)}
                            className="block w-full border-b border-[#eee8dc] bg-[#f7f4ec] p-3 text-left"
                          >
                            <div className="flex h-36 items-center justify-center">
                              <img
                                src={getCaptureDisplayUrl(cap)}
                                alt="capture"
                                className="block h-full w-full rounded-[18px] border border-[#ebe5d7] bg-white object-contain"
                              />
                            </div>
                          </button>
                          <div className="space-y-1 px-4 py-3">
                            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f9475]">
                              Edit Request
                            </p>
                            <p className="text-[13px] leading-relaxed text-[#556255]">
                              {cap.comment || "No edit request provided."}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="m-4 rounded-2xl border border-dashed border-[#d6ddd0] bg-white/70 px-5 py-8 text-center">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#eef3e8] text-[#49704F]">
                        <span className="material-symbols-outlined text-[20px]">
                          crop
                        </span>
                      </div>
                      <p className="text-[13px] font-bold text-[#233227]">
                        No captures yet
                      </p>
                      <p className="mt-2 text-[12px] leading-relaxed text-[#667062]">
                        Select an area in the preview and save it. Captures will
                        appear here for AI context and later review of content,
                        background, color, or layout edits.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Notes tab content */}
              {rightTab === "notes" && (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
                    {activeTarget && (
                      <div className="bg-white border border-[#49704F]/50 ring-2 ring-[#49704F]/20 rounded-2xl p-4 shadow-sm mb-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="material-symbols-outlined text-[#49704F] text-[16px]">
                            add_comment
                          </span>
                          <span className="text-[12px] font-bold text-[#49704F]">
                            Comment on {activeTarget.replace("-", " ")}
                          </span>
                        </div>
                        <textarea
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          placeholder="Type your feedback here..."
                          className="w-full bg-[#FAF7F0] border border-[#e8e6df] rounded-lg p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => {
                              setActiveTarget(null);
                              setCommentText("");
                            }}
                            className="text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#e8e6df]/50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleAddComment}
                            disabled={!commentText.trim()}
                            className="bg-[#49704F] disabled:opacity-50 text-white text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#346E56]"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                    {annotations.map((ann) => (
                      <div key={ann.id} className="relative group">
                        <div className="absolute -left-2 top-0 w-6 h-6 rounded-full border-2 border-white bg-[#49704F] text-white flex items-center justify-center font-bold text-[10px] z-10">
                          {ann.id}
                        </div>
                        <div
                          className={`bg-white border rounded-2xl p-5 ml-2 shadow-sm transition-colors ${activeTarget === ann.targetId ? "border-[#49704F] ring-1 ring-[#49704F]" : "border-[#e8e6df]"}`}
                        >
                          <div className="flex items-center gap-3 mb-3">
                            <div
                              className={`w-8 h-8 rounded-full ${ann.colorClasses} flex items-center justify-center text-[11px] font-bold`}
                            >
                              {ann.initials}
                            </div>
                            <div className="leading-tight">
                              <p className="text-[13px] font-bold text-[#233227]">
                                {ann.author}
                              </p>
                              <p className="text-[10px] text-[#8e9892]">
                                {ann.time}
                              </p>
                            </div>
                          </div>
                          <p className="text-[13px] text-[#5c6860] leading-relaxed mb-4">
                            "{ann.content}"
                          </p>
                          <div className="flex gap-2">
                            <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce]">
                              Reply
                            </button>
                            <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce]">
                              Resolve
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="shrink-0 p-4 border-t border-[#e8e6df]">
                    <button
                      onClick={() => {
                        if (!activeTarget) setActiveTarget("block-1");
                      }}
                      className="w-full bg-[#49704F] text-white text-[13px] font-bold py-3 rounded-full flex items-center justify-center gap-2 hover:bg-[#346E56] shadow-sm"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        add_comment
                      </span>{" "}
                      New Annotation
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full w-14 items-start justify-center pt-6">
              <button
                type="button"
                onClick={() => setCapturesOpen(true)}
                title="Show panel"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
              >
                <span className="material-symbols-outlined text-[16px]">
                  right_panel_open
                </span>
              </button>
            </div>
          )}
        </aside>

        {previewCapture && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-[#233227]/70 p-6 backdrop-blur-sm"
            onClick={() => setPreviewCapture(null)}
          >
            <div
              className="relative max-h-full w-full max-w-5xl overflow-hidden rounded-[28px] border border-[#d8d1c3] bg-[#faf7f0] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 border-b border-[#ece5d8] px-5 py-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7f9475]">
                    Capture Preview
                  </p>
                  <p className="mt-1 text-[13px] text-[#5c6860]">
                    {previewCapture.comment ||
                      "No edit request for this capture."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewCapture(null)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#d9d1c3] bg-white text-[#5c6860] hover:text-[#233227] hover:bg-[#f4f1ea] transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    close
                  </span>
                </button>
              </div>
              <div className="max-h-[80vh] overflow-auto bg-[#f7f4ec] p-5">
                <img
                  src={getCaptureDisplayUrl(previewCapture)}
                  alt="capture preview"
                  className="mx-auto block max-w-full rounded-[22px] border border-[#ebe5d7] bg-white"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Editor;
