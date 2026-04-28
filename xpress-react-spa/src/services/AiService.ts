export interface AiEditRequestPayload {
    prompt?: string;
    language?: string;
    pageContext?: {
        reactUrl?: string;
        reactRoute?: string;
        wordpressUrl?: string;
        wordpressRoute?: string | null;
        iframeSrc?: string;
        pageTitle?: string;
        viewport?: {
            width: number;
            height: number;
            scrollX: number;
            scrollY: number;
            dpr: number;
        };
        document?: {
            width: number;
            height: number;
        };
    };
    attachments?: Array<{
        id: string;
        note?: string;
        sourcePageUrl?: string;
        captureContext?: {
            capturedAt?: string;
            iframeSrc?: string;
            viewport?: {
                width: number;
                height: number;
                scrollX?: number;
                scrollY?: number;
                dpr?: number;
            };
            page?: {
                url?: string;
                route?: string | null;
                title?: string;
            };
            document?: {
                width: number;
                height: number;
            };
        };
        selection?: {
            x: number;
            y: number;
            width: number;
            height: number;
            coordinateSpace?: 'iframe-viewport' | 'iframe-document';
        };
        geometry?: {
            viewportRect?: {
                x: number;
                y: number;
                width: number;
                height: number;
                coordinateSpace?: 'iframe-viewport';
            };
            documentRect?: {
                x: number;
                y: number;
                width: number;
                height: number;
                coordinateSpace?: 'iframe-document';
            };
            normalizedRect?: {
                x: number;
                y: number;
                width: number;
                height: number;
                coordinateSpace?: 'iframe-document-normalized';
            };
        };
        domTarget?: {
            cssSelector?: string;
            xpath?: string;
            tagName?: string;
            elementId?: string;
            classNames?: string[];
            htmlSnippet?: string;
            textSnippet?: string;
            blockName?: string;
            blockClientId?: string;
            domPath?: string;
            role?: string;
            ariaLabel?: string;
            nearestHeading?: string;
            nearestLandmark?: string;
        };
        targetNode?: {
            nodeId?: string;
            sourceNodeId?: string;
            sourceFile?: string;
            topLevelIndex?: number;
            templateName?: string;
            ownerNodeId?: string;
            ownerSourceNodeId?: string;
            ownerSourceFile?: string;
            ownerTopLevelIndex?: number;
            ownerTemplateName?: string;
            editNodeId?: string;
            editSourceNodeId?: string;
            editSourceFile?: string;
            editTopLevelIndex?: number;
            editTemplateName?: string;
            editNodeRole?: string;
            editTagName?: string;
            ancestorSourceNodeIds?: string[];
            route?: string | null;
            blockName?: string;
            blockClientId?: string;
            tagName?: string;
            domPath?: string;
            nearestHeading?: string;
            nearestLandmark?: string;
        };
        asset: {
            provider: 'local' | 'cloudinary' | 'imagekit';
            fileName: string;
            publicUrl: string;
            storagePath?: string;
            originalPath?: string;
            mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
            bytes?: number;
            width?: number;
            height?: number;
            createdAt?: string;
            providerAssetId?: string;
            providerAssetPath?: string;
            format?: string;
        };
    }>;
    targetHint?: {
        templateName?: string;
        componentName?: string;
        route?: string | null;
        sectionIndex?: number;
        sectionType?: string;
        sourceNodeId?: string;
        sectionKey?: string;
        sectionComponentName?: string;
        sourceFile?: string;
        outputFilePath?: string;
        startLine?: number;
        endLine?: number;
        targetNodeRole?: string;
        targetElementTag?: string;
        targetTextPreview?: string;
        targetStartLine?: number;
    };
    constraints?: {
        preserveOutsideSelection?: boolean;
        preserveDataContract?: boolean;
        rerunFromScratch?: boolean;
    };
}

export interface ReactVisualEditRouteEntry {
    route: string;
    componentName: string;
}

export interface ReactVisualEditPayload extends AiEditRequestPayload {
    targetHint?: {
        // Route-level context
        route?: string | null;
        // Section identity (from data-vp-* / ui-source-map)
        sourceNodeId?: string;
        sectionKey?: string;
        componentName?: string;
        sectionComponentName?: string;
        templateName?: string;
        sourceFile?: string;
        // Code location (from ui-source-map)
        outputFilePath?: string;
        startLine?: number;
        endLine?: number;
        // Child node targeting
        targetNodeRole?: string;
        targetElementTag?: string;
        targetTextPreview?: string;
        targetStartLine?: number;
    };
    constraints?: {
        preserveOutsideSelection?: boolean;
        preserveDataContract?: boolean;
        rerunFromScratch?: boolean;
    };
    reactSourceTarget: {
        previewDir?: string;
        frontendDir?: string;
        previewUrl?: string;
        apiBaseUrl?: string;
        uiSourceMapPath?: string;
        routeEntries?: ReactVisualEditRouteEntry[];
    };
}

export class AiProcessError extends Error {
    status: number;
    code?: string;
    details?: unknown;

    constructor(
        message: string,
        status: number,
        code?: string,
        details?: unknown,
    ) {
        super(message);
        this.name = 'AiProcessError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

export const runAiProcess = async (
    siteId: string,
    editRequest?: AiEditRequestPayload,
) => {
    try {
        const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ siteId, editRequest })
        });
        if (!response.ok) {
            let errorPayload: any = null;
            try {
                errorPayload = await response.json();
            } catch {
                errorPayload = null;
            }
            throw new AiProcessError(
                errorPayload?.message || 'Failed to start AI pipeline.',
                response.status,
                errorPayload?.code,
                errorPayload?.details,
            );
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching repos:', error);
        throw error;
    }
};

export interface ReactVisualEditResult {
    accepted: boolean;
    jobId: string;
    siteId: string;
    logPath: string;
    result?: {
        componentName: string;
        filePath: string;
        isValid: boolean;
        warnings: string[];
    };
    error?: string;
}

export interface PendingEditDecisionResult {
    accepted: boolean;
    resumed: boolean;
    jobId: string;
    siteId: string;
    action: 'apply' | 'skip';
    error?: string;
}

export const undoReactVisualEdit = async (
    siteId: string,
    jobId: string,
): Promise<{ undone: boolean; jobId: string; siteId: string; componentFile?: string; error?: string }> => {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/react-visual-edit/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, jobId }),
    });
    if (!response.ok) {
        let errorPayload: any = null;
        try { errorPayload = await response.json(); } catch { errorPayload = null; }
        throw new AiProcessError(
            errorPayload?.message || 'Failed to undo visual edit.',
            response.status,
            errorPayload?.code,
            errorPayload?.details,
        );
    }
    return response.json();
};

export const applyPendingEditRequest = async (
    siteId: string,
    jobId: string,
): Promise<PendingEditDecisionResult> => {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/approve-pending-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, jobId }),
    });
    if (!response.ok) {
        let errorPayload: any = null;
        try { errorPayload = await response.json(); } catch { errorPayload = null; }
        throw new AiProcessError(
            errorPayload?.message || 'Failed to apply the pending edit request.',
            response.status,
            errorPayload?.code,
            errorPayload?.details,
        );
    }
    return response.json();
};

export const skipPendingEditRequest = async (
    siteId: string,
    jobId: string,
): Promise<PendingEditDecisionResult> => {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/skip-pending-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, jobId }),
    });
    if (!response.ok) {
        let errorPayload: any = null;
        try { errorPayload = await response.json(); } catch { errorPayload = null; }
        throw new AiProcessError(
            errorPayload?.message || 'Failed to skip the pending edit request.',
            response.status,
            errorPayload?.code,
            errorPayload?.details,
        );
    }
    return response.json();
};

export const submitReactVisualEdit = async (
    siteId: string,
    jobId: string,
    editRequest: ReactVisualEditPayload,
): Promise<ReactVisualEditResult> => {
    try {
        const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/react-visual-edit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ siteId, jobId, editRequest })
        });
        if (!response.ok) {
            let errorPayload: any = null;
            try {
                errorPayload = await response.json();
            } catch {
                errorPayload = null;
            }
            throw new AiProcessError(
                errorPayload?.message || 'Failed to submit React visual edit request.',
                response.status,
                errorPayload?.code,
                errorPayload?.details,
            );
        }
        return response.json();
    } catch (error) {
        console.error('Error submitting React visual edit request:', error);
        throw error;
    }
};
