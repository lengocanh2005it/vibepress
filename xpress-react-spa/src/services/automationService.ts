export const getMyRepos = async (token: string) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/repos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Failed to fetch repos');
    }
    const data = await response.json();
    return data.repos;
  } catch (error) {
    console.error('Error fetching repos:', error);
    throw error;
  }
};

export interface CaptureViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export const captureRegion = async (
  pageUrl: string,
  proxyUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  comment: string,
  viewport: CaptureViewport,
) => {
  const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageUrl, proxyUrl, rect, comment, viewport }),
  });
  if (!response.ok) throw new Error('Failed to capture region');
  return response.json() as Promise<{ success: boolean; filePath: string; comment: string; pageUrl: string }>;
};

export const getWpSitePages = async (siteUrl: string) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/site-pages?siteUrl=${encodeURIComponent(siteUrl)}`);
    if (!response.ok) {
      throw new Error('Failed to fetch site pages');
    }
    const data = await response.json();
    return data.pages;
  } catch (error) {
    console.error('Error fetching site pages:', error);
    throw error;
  }
};

export const getThemesFolders = async (repoUrl: string) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/themes?repoUrl=${encodeURIComponent(repoUrl)}`);
    if (!response.ok) {
      throw new Error('Failed to fetch themes');
    }
    const data = await response.json();
    return data.themes as { name: string; path: string; url: string }[];
  } catch (error) {
    console.error('Error fetching themes:', error);
    throw error;
  }
};

export interface CommitHistoryResponse {
  commits: {
    sha: string;
    message: string;
    author: string;
    date: string;
    avatarUrl: string | null;
  }[];
  pagination: {
    page: number;
    perPage: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export const getCommitHistory = async (
  repoUrl: string,
  page = 1,
  perPage = 10,
) => {
  try {
    const response = await fetch(
      `${import.meta.env.VITE_BACKEND_URL}/api/wp/commits?repoUrl=${encodeURIComponent(repoUrl)}&page=${page}&perPage=${perPage}`,
    );
    if (!response.ok) {
      throw new Error('Failed to fetch commit history');
    }
    const data = await response.json();
    return {
      commits: data.commits ?? [],
      pagination: data.pagination ?? {
        page,
        perPage,
        hasNextPage: false,
        hasPrevPage: page > 1,
      },
    } as CommitHistoryResponse;
  } catch (error) {
    console.error('Error fetching commit history:', error);
    throw error;
  }
};
