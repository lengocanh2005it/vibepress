import React, { createContext, useContext, useState } from 'react';

export interface AuthUser {
  id: string;
  email: string;
  apiKey: string;
}

interface UserContextType {
  user: AuthUser | null;
  token: string | null;
  setAuth: (user: AuthUser, token: string) => void;
  clearAuth: () => void;
  // backward-compat: một số nơi vẫn dùng email
  email: string | null;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

function loadFromStorage(): { user: AuthUser | null; token: string | null } {
  try {
    const token = localStorage.getItem('vp_token');
    const raw   = localStorage.getItem('vp_user');
    if (token && raw) {
      return { user: JSON.parse(raw), token };
    }
  } catch {}
  return { user: null, token: null };
}

export const UserProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user,  setUser]  = useState<AuthUser | null>(() => loadFromStorage().user);
  const [token, setToken] = useState<string | null>(() => loadFromStorage().token);

  const setAuth = (u: AuthUser, t: string) => {
    localStorage.setItem('vp_user',  JSON.stringify(u));
    localStorage.setItem('vp_token', t);
    setUser(u);
    setToken(t);
  };

  const clearAuth = () => {
    localStorage.removeItem('vp_user');
    localStorage.removeItem('vp_token');
    setUser(null);
    setToken(null);
  };

  return (
    <UserContext.Provider value={{ user, token, setAuth, clearAuth, email: user?.email ?? null }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = (): UserContextType => {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
};
