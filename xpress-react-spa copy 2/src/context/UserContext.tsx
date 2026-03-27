import React, { createContext, useContext, useState } from 'react';

interface UserContextType {
  email: string | null;
  setEmail: (email: string | null) => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export const UserProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [email, setEmailState] = useState<string | null>(
    () => localStorage.getItem('user_email')
  );

  const setEmail = (value: string | null) => {
    if (value === null) {
      localStorage.removeItem('user_email');
    } else {
      localStorage.setItem('user_email', value);
    }
    setEmailState(value);
  };

  return (
    <UserContext.Provider value={{ email, setEmail }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = (): UserContextType => {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
};
