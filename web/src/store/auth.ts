// 认证状态
import { create } from 'zustand';
import { authApi } from '../api';
import { clearToken, setToken } from '../api/client';
import type { UserInfo } from '../api/types';

interface AuthState {
  user: UserInfo | null;
  ready: boolean;
  setUser: (u: UserInfo | null) => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,

  setUser: (u) => set({ user: u }),

  login: async (username, password) => {
    const res = await authApi.login(username, password);
    setToken(res.accessToken);
    set({ user: res.user, ready: true });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      clearToken();
      set({ user: null });
    }
  },

  bootstrap: async () => {
    try {
      const res = await authApi.me();
      set({ user: res.user, ready: true });
    } catch {
      clearToken();
      set({ user: null, ready: true });
    }
  },
}));
