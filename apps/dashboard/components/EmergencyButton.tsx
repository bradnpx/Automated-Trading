"use client";
import React, { useState } from "react";

export default function EmergencyButton() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "dead">("idle");

  const handlePanic = async () => {
    if (!confirm("Are you sure? This will sell everything immediately")) return;

    setLoading(true);
    try {
      const res = await fetch("http://localhost:4001/panic", {
        method: "POST",
      });
      if (res.ok) setStatus("dead");
    } catch (err) {
      alert("Failed to reach engine!");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    setLoading(true);
    try {
      const res = await fetch("http://localhost:4001/reset", {
        method: "POST",
      });
      if (res.ok) setStatus("idle");
    } catch (err) {
      console.error("Reset failed", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="p-6 border-2 border-red-500 rounded-lg bg-red-50">
        <h2 className="text-red-700 font-bold mb-4">SYSTEM SAFETY</h2>

        {status !== "dead" ? (
          <button
            onClick={handlePanic}
            disabled={loading}
            className={`w-full py-4 text-white font-black rounded-md shadow-xl transition-transform active:scale-95 ${status === "dead" ? "bg-gray-500" : "bg-red-600 hover:bg-red-700"}`}
          >
            {loading
              ? "EXECUTING..."
              : "KILL ALL SYSTEMS"}
          </button>
        ) : (
          <button
            onClick={handleReset}
            disabled={loading}
            className="w-full py-4 bg-yellow-500 hover:bg-yellow-600 text-black font-black rounded-md shadow-lg transition-transform active:scale-95 disabled:opacity-50"
          >
            {loading ? "RESYNCING..." : "RE-ENABLE ENGINE"}
          </button>
        )}
        {status === "dead" && (
          <p className="mt-2 text-xs text-red-600 text-center uppercase tracking-wideset">
            Manual Reset Required on Server
          </p>
        )}
      </div>
    </>
  );
}
