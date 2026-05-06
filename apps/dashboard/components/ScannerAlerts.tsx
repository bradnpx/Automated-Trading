"use client";
import { useTradingSocket } from "@/context/SocketContext";

export default function ScannerAlerts() {
  const { alerts } = useTradingSocket();

//   if (alerts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none">
        YOTON SAYS THERE AIN'T NO SCANNER YET, MOTHERFUCKERS
      {alerts.map((alert, i) => (
        <div
          key={`${alert.symbol}-${i}`}
          className="bg-orange-600 text-white px-4 py-3 rounded-lg shadow-2xl border-2 border-orange-400 flex items-center gap-3 animate-in slide-in-from-right duration-500"
        >
          <div className="bg-white/20 p-1 rounded font-black text-xs">HOT</div>
          <div>
            <span className="font-black text-lg">{alert.symbol}</span>
            <span className="ml-2 text-xs opacity-90">
              RVOL: {alert.rvol.toFixed(2)}x
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
