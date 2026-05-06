"use client";
import React, { useState } from "react";
import { useTradingSocket } from "@/context/SocketContext";

export default function ClosePositionButton({ symbol }: { symbol: string }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "dead">("idle");

  const handleClose = async (sym: string) => {
    console.log("click!!", sym);
    setLoading(true);
    try {
      const res = await fetch("http://localhost:4001/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!res.ok) {
        const error = await res.json();
        console.error("Close failed:", error);
      }
    } catch (err) {
      alert("Failed to reach engine, Yoton!");
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      id={symbol}
      onClick={() => handleClose(symbol)}
      className="text-white bg-red-500 rounded-md m-2 px-5 py-1"
    >
      Sell
    </button>
  );
}
