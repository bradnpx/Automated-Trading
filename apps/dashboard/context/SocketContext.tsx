"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  ReactNode,
} from "react";
import { io } from "socket.io-client";
import {
  AccountPayload,
  HealthStatus,
  PremarketMode,
  PremarketModePayload,
  PremarketOrderProposal,
  SOCKET_EVENTS,
  SocketBarPayload,
  TradeSignal,
} from "@my-platform/types";

type TickerData = SocketBarPayload & { direction: "up" | "down" | "flat" };
type PortfolioPayload = Record<string, unknown>;

interface ScannerAlertPayload {
  symbol: string;
  rvol: number;
  timestamp: string;
}

interface SocketContextValue {
  health: HealthStatus | null;
  tableData: TickerData[];
  signals: TradeSignal[];
  portfolio: PortfolioPayload[];
  account: AccountPayload | null;
  alerts: ScannerAlertPayload[];
  equityHistory: { time: string; equity: number }[];
  engineStatus: "ACTIVE" | "KILLED";
  premarketMode: PremarketMode;
  premarketModeError: string | null;
  premarketProposals: PremarketOrderProposal[];
  setPremarketMode: (mode: PremarketMode) => Promise<void>;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [tickerMap, setTickerMap] = useState<Record<string, TickerData>>({});
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioPayload[]>([]);
  const [account, setAccount] = useState<AccountPayload | null>(null);
  const [alerts, setAlerts] = useState<ScannerAlertPayload[]>([]);
  const [equityHistory, setEquityHistory] = useState<
    { time: string; equity: number }[]
  >([]);
  const [engineStatus, setEngineStatus] = useState<"ACTIVE" | "KILLED">(
    "ACTIVE",
  );
  const [premarketMode, setPremarketModeState] =
    useState<PremarketMode>("evaluation_only");
  const [premarketModeError, setPremarketModeError] = useState<string | null>(
    null,
  );
  const [premarketProposalMap, setPremarketProposalMap] = useState<
    Record<string, PremarketOrderProposal>
  >({});

  useEffect(() => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket"],
    });

    // socket.onAny((eventName, ...args) => {
    //   console.log(`📡 [Socket] ${eventName}`, args);
    // });

    socket.on("connect", () => console.log("🟢 Socket Connected to Engine!"));
    socket.on("connect_error", (err) =>
      console.error("🔴 Socket Connection Error:", err),
    );

    socket.on(SOCKET_EVENTS.HEALTH, (data: HealthStatus) => {
      const arrivalTime = Date.now();
      const sentTime = new Date(data.timestamp).getTime();
      setHealth({ ...data, latency: arrivalTime - sentTime });
    });

    socket.on(SOCKET_EVENTS.BAR, (data: SocketBarPayload) => {
      setTickerMap((prev) => {
        const prevPrice = prev[data.symbol]?.price || data.price;
        const direction =
          data.price > prevPrice
            ? "up"
            : data.price < prevPrice
              ? "down"
              : "flat";
        return { ...prev, [data.symbol]: { ...data, direction } };
      });
    });

    socket.on(SOCKET_EVENTS.SIGNAL, (signal: TradeSignal) => {
      setSignals((prev) => [signal, ...prev].slice(0, 50));
    });

    socket.on(SOCKET_EVENTS.PREMARKET_MODE, (payload: PremarketModePayload) => {
      setPremarketModeState(payload.mode);
      setPremarketModeError(null);
      if (payload.mode === "evaluation_only") {
        setPremarketProposalMap({});
      }
    });

    socket.on(
      SOCKET_EVENTS.PREMARKET_ORDER_PROPOSAL,
      (proposal: PremarketOrderProposal) => {
        setPremarketProposalMap((previous) => ({
          ...previous,
          [proposal.symbol]: proposal,
        }));
      },
    );

    socket.on(SOCKET_EVENTS.STATUS, (data: { status: "ACTIVE" | "KILLED" }) => {
      setEngineStatus(data.status);
    });

    socket.on(SOCKET_EVENTS.UPDATE, (data: PortfolioPayload[]) => {
      setPortfolio(data);
    });

    socket.on(SOCKET_EVENTS.SCANNER, (data: ScannerAlertPayload) => {
      setAlerts((prev) => [data, ...prev].slice(0, 5));
    });

    socket.on(SOCKET_EVENTS.ACCOUNT, (data: AccountPayload) => {
      setAccount(data);
      setEquityHistory((prev) => {
        const newPoint = {
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          equity: data.equity,
        };
        return [...prev, newPoint].slice(-100);
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    async function loadPremarketMode() {
      try {
        const response = await fetch("http://localhost:4001/premarket-mode");
        if (!response.ok) {
          throw new Error(`Engine responded with ${response.status}`);
        }

        const payload = (await response.json()) as PremarketModePayload;
        setPremarketModeState(payload.mode);
        setPremarketModeError(null);
      } catch (error) {
        setPremarketModeError(
          error instanceof Error
            ? `Could not load premarket mode: ${error.message}`
            : "Could not load premarket mode.",
        );
      }
    }

    void loadPremarketMode();
  }, []);

  const tableData = useMemo(() => Object.values(tickerMap), [tickerMap]);
  const premarketProposals = useMemo(
    () =>
      Object.values(premarketProposalMap).sort(
        (left, right) =>
          new Date(right.generatedAt).getTime() -
          new Date(left.generatedAt).getTime(),
      ),
    [premarketProposalMap],
  );

  async function setPremarketMode(mode: PremarketMode): Promise<void> {
    const response = await fetch("http://localhost:4001/premarket-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      const message =
        payload?.error ?? `Engine responded with ${response.status}`;
      setPremarketModeError(message);
      throw new Error(message);
    }

    const payload = (await response.json()) as PremarketModePayload;
    setPremarketModeState(payload.mode);
    setPremarketModeError(null);
    if (payload.mode === "evaluation_only") {
      setPremarketProposalMap({});
    }
  }

  const value: SocketContextValue = {
    health,
    tableData,
    signals,
    portfolio,
    account,
    alerts,
    equityHistory,
    engineStatus,
    premarketMode,
    premarketModeError,
    premarketProposals,
    setPremarketMode,
  };

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useTradingSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error("useTradingSocket must be used within a SocketProvider");
  }
  return context;
}
