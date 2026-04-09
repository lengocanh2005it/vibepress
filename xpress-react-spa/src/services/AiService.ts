export interface AiEditRequestPayload {
    prompt: string;
    language?: string;
    pageContext?: {
        reactUrl?: string;
        reactRoute?: string;
        wordpressUrl?: string;
        iframeSrc?: string;
        viewport?: {
            width: number;
            height: number;
            scrollX: number;
            scrollY: number;
            dpr: number;
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
        };
        selection?: {
            x: number;
            y: number;
            width: number;
            height: number;
            coordinateSpace?: 'iframe-viewport' | 'iframe-document';
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
            throw new Error('Failed to fetch repos');
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching repos:', error);
        throw error;
    }
};
