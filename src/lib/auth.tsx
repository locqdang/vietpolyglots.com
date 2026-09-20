'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

type User = Record<string, unknown>;

type AuthContextValue = {
  user: User | null;
  token: null;
  loading: boolean;
  login: (_newToken: string | null, newUser: User) => void;
  logout: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

type SessionResponse = {
  authenticated?: boolean;
  user?: User | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const privateRoutes = ['/video-meeting', '/haro', '/image-generate'];

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    const loadSession = async () => {
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        const data = (await response.json().catch(() => null)) as SessionResponse | null;

        if (!cancelled && response.ok && data?.authenticated && data.user) {
          setUser(data.user);
        } else if (!cancelled) {
          setUser(null);
        }
      } catch {
        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = (_newToken: string | null, newUser: User) => {
    setUser(newUser);
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Best effort, local auth state is still cleared below.
    }

    setUser(null);
  };

  const value = useMemo(() => ({ user, token: null, loading, login, logout }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const { user, loading } = useAuth();
  const isPrivateRoute = privateRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  useEffect(() => {
    if (!loading && !user && isPrivateRoute) {
      const redirect = encodeURIComponent(pathname || '/');
      void router.replace(`/login?redirect=${redirect}`);
    }
  }, [loading, user, router, isPrivateRoute, pathname]);

  if (loading) {
    return null;
  }

  if (isPrivateRoute && !user) {
    return null;
  }

  return <>{children}</>;
}
