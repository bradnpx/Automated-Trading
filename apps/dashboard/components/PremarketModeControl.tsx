"use client";

import { useState } from "react";

import { useTradingSocket } from "@/context/SocketContext";
import type { PremarketMode } from "@my-platform/types";

const MODE_COPY: Record<PremarketMode, { title: string; description: string }> =
  {
    evaluation_only: {
      title: "Evaluation Only",
      description:
        "Premarket signals are evaluated and logged, but no review proposal is created.",
    },
    manual_review: {
      title: "Manual Review",
      description:
        "Premarket BUY signals create a non-submitting extended-hours limit-order proposal for review.",
    },
  };

export default function PremarketModeControl() {
  const { engineStatus, premarketMode, premarketModeError, setPremarketMode } =
    useTradingSocket();
  const [pendingMode, setPendingMode] = useState<PremarketMode | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function selectMode(mode: PremarketMode): Promise<void> {
    if (mode === premarketMode || pendingMode) return;

    setPendingMode(mode);
    setRequestError(null);
    try {
      await setPremarketMode(mode);
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : "Unable to update premarket review mode.",
      );
    } finally {
      setPendingMode(null);
    }
  }

  const activeCopy = MODE_COPY[premarketMode];
  const error = requestError ?? premarketModeError;

  return (
    <section
      aria-labelledby="premarket-mode-heading"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
            <h2
              id="premarket-mode-heading"
              className="text-sm font-bold uppercase tracking-wide text-amber-950"
            >
              Premarket Signal Mode
            </h2>
          </div>
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {activeCopy.title}
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">
            {activeCopy.description}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            engineStatus === "ACTIVE"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-rose-100 text-rose-800"
          }`}
        >
          Engine {engineStatus === "ACTIVE" ? "active" : "stopped"}
        </span>
      </div>

      <div
        className="mt-4 grid gap-2 sm:grid-cols-2"
        role="group"
        aria-label="Premarket signal mode"
      >
        {(Object.keys(MODE_COPY) as PremarketMode[]).map((mode) => {
          const isActive = premarketMode === mode;
          const isUpdating = pendingMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={isActive}
              disabled={pendingMode !== null}
              onClick={() => void selectMode(mode)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                isActive
                  ? "border-amber-600 bg-amber-600 text-white"
                  : "border-amber-200 bg-white text-slate-700 hover:border-amber-400 hover:bg-amber-100"
              }`}
            >
              <span className="block text-sm font-semibold">
                {isUpdating ? "Updating…" : MODE_COPY[mode].title}
              </span>
              <span
                className={`mt-0.5 block text-xs leading-4 ${
                  isActive ? "text-amber-50" : "text-slate-500"
                }`}
              >
                {mode === "evaluation_only"
                  ? "Suppress proposals"
                  : "Show proposals only"}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs font-medium text-amber-900">
        No mode submits, routes, or modifies an Alpaca order. Regular-session
        automation is unchanged.
      </p>
      {error && (
        <p className="mt-2 text-xs font-medium text-rose-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
