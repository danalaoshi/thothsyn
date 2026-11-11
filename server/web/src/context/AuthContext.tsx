import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase";

interface AuthValue {
  supabase: SupabaseClient | null;
  session: Session | null;
  user: User | null;
  token: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsConfirm: boolean }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  updateEmail: (email: string) => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getSupabase()
      .then((c) => {
        if (!active) return;
        setSupabase(c);
        c.auth.getSession().then(({ data }) => {
          if (!active) return;
          setSession(data.session);
          setLoading(false);
        });
        c.auth.onAuthStateChange((_e, s) => {
          if (!active) return;
          setSession(s);
          setLoading(false);
        });
      })
      .catch(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const value: AuthValue = {
    supabase,
    session,
    user: session?.user ?? null,
    token: session?.access_token ?? null,
    loading,
    signIn: async (email, password) => {
      const c = await getSupabase();
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    signUp: async (email, password) => {
      const c = await getSupabase();
      const { data, error } = await c.auth.signUp({ email, password });
      if (error) throw error;
      return { needsConfirm: !data.session };
    },
    signOut: async () => {
      const c = await getSupabase();
      await c.auth.signOut();
    },
    resetPassword: async (email) => {
      const c = await getSupabase();
      const { error } = await c.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/manage/`,
      });
      if (error) throw error;
    },
    updatePassword: async (password) => {
      const c = await getSupabase();
      const { error } = await c.auth.updateUser({ password });
      if (error) throw error;
    },
    updateEmail: async (email) => {
      const c = await getSupabase();
      const { error } = await c.auth.updateUser({ email });
      if (error) throw error;
    },
    resendConfirmation: async (email) => {
      const c = await getSupabase();
      const { error } = await c.auth.resend({ type: "signup", email });
      if (error) throw error;
    },
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
