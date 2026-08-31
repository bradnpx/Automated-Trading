import React, { useState } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isToday,
} from "date-fns";
import type { Trade } from "@/lib/fetchTradeHistory";

// Dummy schema lookup type
interface DayEarning {
  amount: number;
  transactions: number;
}

interface EarningsData {
  currency: string;
  month: string;
  earnings: Record<string, DayEarning>;
}

// Mocked feed matching the schema
const mockFeed: EarningsData = {
  currency: "USD",
  month: "2026-08",
  earnings: {
    "2026-08-01": { amount: 120.5, transactions: 4 },
    "2026-08-03": { amount: 450.75, transactions: 12 },
    "2026-08-11": { amount: 890.0, transactions: 19 },
    "2026-08-14": { amount: 310.2, transactions: 8 }, // Today
    "2026-08-25": { amount: 1250.0, transactions: 25 },
  },
};

interface Props {
  trades: Trade[];
}

export default function Calendar({ trades }: Trade[]) {
  const [currentDate, setCurrentDate] = useState(new Date());


  // Compile the earnings by day
  const earningsMap = new Map<string, DayEarning>();
  for (const t of trades) {
    if (!t) {
      continue;
    }
    const date = t.closedOn.split("T")[0];
    const current: DayEarning = earningsMap.get(date) || {
      amount: 0,
      transactions: 0,
    };
    const addition: DayEarning = {
      amount: current.amount + (t.pnl * t.qty),
      transactions: current.transactions + 1,
    };

    if (!earningsMap.get(date)) {
      earningsMap.set(date, current);
    }
    earningsMap.set(date, addition);
  }
  
  const earnings: EarningsData = {
    currency: "USD",
    month: "2026-08",
    earnings: Object.fromEntries(earningsMap),
  };
  
  console.log(earnings)
  console.log(currentDate)


  // Generate perfect grid alignment days using date-fns
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);

  const allGridDays = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="w-full max-w-4xl mx-auto p-4 bg-slate-900 text-white rounded-xl shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 px-2">
        <h2 className="text-xl font-bold tracking-tight">
          {format(currentDate, "MMMM yyyy")} Earnings
        </h2>
        <div className="text-sm text-slate-400 bg-slate-800 px-3 py-1 rounded-full border border-slate-700">
          Currency:{" "}
          <span className="font-semibold text-emerald-400">
            {mockFeed.currency}
          </span>
        </div>
      </div>

      {/* Weekday Labels */}
      <div className="grid grid-cols-7 gap-2 mb-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wider">
        {weekDays.map((day) => (
          <div key={day} className="py-1">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-2">
        {allGridDays.map((day, idx) => {
          const dateString = format(day, "yyyy-MM-dd");
          // const dayData = mockFeed.earnings[dateString];
          const dayData = earnings.earnings[dateString];
          const isCurrentMonth = isSameMonth(day, currentDate);
          const isCurrentDay = isToday(day);

          return (
            <div
              key={idx}
              className={`min-h-[90px] p-2 rounded-lg border transition-all flex flex-col justify-between
                ${isCurrentMonth ? "bg-slate-800 border-slate-700" : "bg-slate-900/40 border-slate-800 text-slate-600"}
                ${isCurrentDay ? "ring-2 ring-emerald-500 border-transparent" : ""}
              `}
            >
              {/* Day Number */}
              <div className="flex justify-between items-center">
                <span
                  className={`text-sm font-semibold ${isCurrentDay ? "text-emerald-400 font-bold" : ""}`}
                >
                  {format(day, "d")}
                </span>
                {dayData && dayData.transactions > 0 && isCurrentMonth && (
                  <span className="text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded-md">
                    {dayData.transactions}tx
                  </span>
                )}
              </div>

              {/* Data Injection */}
              <div className="mt-2 text-right">
                {isCurrentMonth && dayData ? (
                  <div
                    className={`text-sm font-bold ${dayData.amount > 0 ? 'text-emerald-400' : 'text-red-600' } tracking-tight`}
                  >
                    ${dayData.amount.toFixed(2)}
                  </div>
                ) : isCurrentMonth ? (
                  <div className="text-xs text-slate-500 font-medium">
                    $0.00
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
