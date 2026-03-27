export const getRepoByEmail = async (email: string) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/repos?email=${encodeURIComponent(email)}`);
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

export const captureRegion = async (
  pageUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  comment: string
) => {
  const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageUrl, rect, comment }),
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

export const getCommitHistory = async (repoUrl: string) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/wp/commits?repoUrl=${encodeURIComponent(repoUrl)}`);
    if (!response.ok) {
      throw new Error('Failed to fetch commit history');
    }
    const data = await response.json();
    return data.commits;
  } catch (error) {
    console.error('Error fetching commit history:', error);
    throw error;
  }
};
