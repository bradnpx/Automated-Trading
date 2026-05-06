"use client";
import { useTradingSocket } from "@/context/SocketContext";

export default function HealthMonitor() {
  const { health } = useTradingSocket();

  if (!health) return null;

  const isLagging = health.latency > 200;
  const isBroken = health.alpacaStream === "DISCONNECTED";

  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-slate-900 border-t border-slate-800 text-[10px] font-mono fixed bottom-0 left-0 right-0 z-50">
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full ${isBroken ? "bg-red-500 animate-pulse" : "bg-green-500"}`}
        />
        <span className="text-slate-400 uppercase">Alpaca:</span>
        <span className={isBroken ? "text-red-400" : "text-slate-200"}>
          {health.alpacaStream}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-slate-400 uppercase">Latency:</span>
        <span className={isLagging ? "text-yellow-400" : "text-slate-200"}>
          {health.latency}ms
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-slate-400 uppercase">Heap:</span>
        <span className="text-slate-200">{health.memoryUsage}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-slate-400 uppercase">Uptime:</span>
        <span className="text-slate-200">{health.uptime}</span>
      </div>

      <div className="ml-auto text-slate-500">
        Engine v1.0.4 - {new Date(health.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}
