import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, UserProfile, getStoredToken, getStoredUser, clearAuthSession, AUTH_EXPIRED_EVENT } from "../api/client";
import { clearAlarmLogs } from "./alarmLogStore";
import { clearPlantCache } from "./plantCache";
import { clearAssistantThreads } from "../components/assistant/useAssistantChat";
import { releasePush } from "../lib/push";

export interface AuthContextValue {
  user: UserProfile | null;
  /** false until the stored token has been checked (show a splash, not the login page) */
  authChecked: boolean;
  loginAs: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** string open in the String Inspector drawer (any page) */
  inspectedStringId: string | null;
  setInspectedStringId: (id: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Signed-in user only. No data is loaded here: each route's providers load what it needs. */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(getStoredUser());
  const [authChecked, setAuthChecked] = useState(false);
  const [inspectedStringId, setInspectedStringId] = useState<string | null>(null);

  // Restore the session from a stored token; without one the login page is shown.
  // (No automatic sign-in: every visitor must log in with their own username.)
  useEffect(() => {
    (async () => {
      if (getStoredToken()) {
        try {
          setUser(await api.me());
        } catch {
          clearAuthSession();
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setAuthChecked(true);
    })();
  }, []);

  // Any 401 from the API (expired token, disabled account) signs out.
  useEffect(() => {
    const onExpired = () => {
      clearAssistantThreads();
      void releasePush(false); // the session is gone: only this browser's subscription can be dropped
      setUser(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const loginAs = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    // before the token is cleared: alarm notifications of this user's plants stop on this browser
    void releasePush(true);
    clearAuthSession();
    // the next user may see other plants
    clearAlarmLogs();
    clearPlantCache();
    clearAssistantThreads();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, authChecked, loginAs, logout, inspectedStringId, setInspectedStringId }),
    [user, authChecked, loginAs, logout, inspectedStringId]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
