

export const runAiProcess = async (email: string) => {
    try {
        const response = await fetch(`${import.meta.env.VITE_BACKEND_AI_URL}/pipeline/run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
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