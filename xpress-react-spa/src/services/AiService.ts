export interface AiEditRequestCapture {
    id: string;
    filePath: string;
    url: string;
    comment: string;
    pageUrl: string;
}

export interface AiEditRequestPayload {
    userPrompt: string;
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
    captures?: AiEditRequestCapture[];
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
