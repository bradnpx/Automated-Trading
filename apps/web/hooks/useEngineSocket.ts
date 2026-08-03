// hooks/useEngineSocket.ts
// Client-side hook that connects to the engine's Socket.IO broadcaster and
// pipes incoming events into the Zustand engine store.
//
// Usage: mount this once in a top-level Client Component (e.g. the dashboard
// layout) so all child components can read live state from the store without
// each needing their own socket connection.

"use client";

import { useEffect } from "react";
import { io, Socket } from "socket.io-client";
import { useEngineStore } from "@/store/engine.store";
import type {
  Position,
  AccountState,
  TradeSignal,
  HealthStatus,
  EngineStatus,
} from "@/types/dashboard";

// Socket event names must match SOCKET_EVENTS in @my-platform/types
const SOCKET_EVENTS = {
  SIGNAL: "trade_signal",
  UPDATE: "trade_update",
  ACCOUNT: "account_update",
  HEALTH: "system_health",
  STATUS: "engine_status",
} as const;

const ENGINE_SOCKET_URL =
  process.env.NEXT_PUBLIC_ENGINE_SOCKET_URL ?? "http://localhost:4000";

let socket: Socket | null = null;

export function useEngineSocket(): void {
  const {
    setPositions,
    setAccount,
    addSignal,
    setHealth,
    setEngineStatus,
    setConnected,
  } = useEngineStore();

  useEffect(() => {
    // Singleton: reuse the socket across re-renders
    if (!socket) {
      socket = io(ENGINE_SOCKET_URL, { transports: ["websocket"] });
    }

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("portfolio_update", (positions: Position[]) =>
      setPositions(positions),
    );

    socket.on(SOCKET_EVENTS.ACCOUNT, (account: AccountState) =>
      setAccount(account),
    );

    socket.on(SOCKET_EVENTS.SIGNAL, (signal: TradeSignal) =>
      addSignal(signal),
    );

    socket.on(SOCKET_EVENTS.HEALTH, (health: HealthStatus) =>
      setHealth(health),
    );

    socket.on(SOCKET_EVENTS.STATUS, (status: EngineStatus) =>
      setEngineStatus(status),
    );

    return () => {
      // Remove listeners on unmount but keep the socket open for re-mounting
      socket?.removeAllListeners();
    };
  }, [setPositions, setAccount, addSignal, setHealth, setEngineStatus, setConnected]);
}
