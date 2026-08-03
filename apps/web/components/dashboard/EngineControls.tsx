// components/dashboard/EngineControls.tsx
// Panic (kill) and Reset buttons for the engine control panel.
// Reads engine status from Zustand and fires mutations via TanStack Query.

"use client";

import { useEngineStore } from "@/store/engine.store";
import { usePanic, useReset } from "@/hooks/useEngineActions";

export function EngineControls() {
  const engineStatus = useEngineStore((s) => s.engineStatus);
  const isConnected = useEngineStore((s) => s.isConnected);

  const { mutate: panic, isPending: isPanicking } = usePanic();
  const { mutate: reset, isPending: isResetting } = useReset();

  const isKilled = engineStatus === "KILLED";

  return (
    <div className="flex items-center gap-3">
      {/* Connection indicator */}
      <span className="flex items-center gap-1.5 text-xs text-zinc-400">
        <span
          className={`h-2 w-2 rounded-full ${
            isConnected ? "bg-green-400 animate-pulse" : "bg-zinc-600"
          }`}
        />
        {isConnected ? "Live" : "Disconnected"}
      </span>

      {/* Engine status badge */}
      <span
        className={`px-2 py-0.5 rounded text-xs font-semibold ${
          isKilled
            ? "bg-red-900/50 text-red-400 border border-red-800"
            : "bg-green-900/50 text-green-400 border border-green-800"
        }`}
      >
        {isKilled ? "KILLED" : "ACTIVE"}
      </span>

      {/* Reset — only shown when engine is killed */}
      {isKilled && (
        <button
          onClick={() => reset()}
          disabled={isResetting || !isConnected}
          className="px-4 py-1.5 text-sm rounded bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isResetting ? "Resuming…" : "Resume Engine"}
        </button>
      )}

      {/* Panic — only shown when engine is active */}
      {!isKilled && (
        <button
          onClick={() => panic()}
          disabled={isPanicking || !isConnected}
          className="px-4 py-1.5 text-sm rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isPanicking ? "Killing…" : "🚨 Panic Kill"}
        </button>
      )}
    </div>
  );
}
