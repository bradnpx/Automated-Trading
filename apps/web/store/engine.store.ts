// store/engine.store.ts
// Global client-side state for the trading engine dashboard.
// Managed by Zustand — imported with `useEngineStore` in Client Components.
//
// This store is populated by the Socket.IO event listeners in
// hooks/useEngineSocket.ts and read by dashboard UI components.

import { create } from "zustand";
import type {
  Position,
  AccountState,
  TradeSignal,
  HealthStatus,
  EngineStatus,
} from "@/types/dashboard";

interface EngineStore {
  // ─── State ──────────────────────────────────────────────────────────────────
  positions: Position[];
  account: AccountState | null;
  signals: TradeSignal[];
  health: HealthStatus | null;
  engineStatus: EngineStatus;
  isConnected: boolean;

  // ─── Actions ─────────────────────────────────────────────────────────────────
  setPositions: (positions: Position[]) => void;
  setAccount: (account: AccountState) => void;
  addSignal: (signal: TradeSignal) => void;
  setHealth: (health: HealthStatus) => void;
  setEngineStatus: (status: EngineStatus) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

const initialState = {
  positions: [],
  account: null,
  signals: [],
  health: null,
  engineStatus: "ACTIVE" as EngineStatus,
  isConnected: false,
};

export const useEngineStore = create<EngineStore>((set) => ({
  ...initialState,

  setPositions: (positions) => set({ positions }),

  setAccount: (account) => set({ account }),

  // Keep only the last 50 signals to avoid unbounded memory growth
  addSignal: (signal) =>
    set((state) => ({
      signals: [signal, ...state.signals].slice(0, 50),
    })),

  setHealth: (health) => set({ health }),

  setEngineStatus: (engineStatus) => set({ engineStatus }),

  setConnected: (isConnected) => set({ isConnected }),

  reset: () => set(initialState),
}));
