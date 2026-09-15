"use client";

import { useTradingSocket } from "@/context/SocketContext";

export default function PremarketOrderProposals() {
  const { premarketMode, premarketProposals } = useTradingSocket();

  return (
    <section
      aria-labelledby="premarket-proposals-heading"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-950 px-4 py-3">
        <div>
          <h2
            id="premarket-proposals-heading"
            className="text-sm font-bold text-slate-100"
          >
            Premarket Manual Review
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Non-submitting limit-order proposals only
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
            premarketMode === "manual_review"
              ? "bg-amber-400 text-amber-950"
              : "bg-slate-700 text-slate-200"
          }`}
        >
          {premarketMode === "manual_review"
            ? "Review enabled"
            : "Evaluation only"}
        </span>
      </div>

      {premarketMode === "evaluation_only" ? (
        <EmptyState message="Enable Manual Review to display premarket BUY proposals. Signals remain evaluation-only until then." />
      ) : premarketProposals.length === 0 ? (
        <EmptyState message="Waiting for a qualifying premarket BUY signal from a scanner symbol." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {premarketProposals.map((proposal) => (
            <li key={proposal.symbol} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-base font-bold text-blue-700">
                    {proposal.symbol}
                  </p>
                  <p className="text-xs text-slate-500">{proposal.strategy}</p>
                </div>
                <time
                  className="text-right text-[11px] text-slate-400"
                  dateTime={proposal.generatedAt}
                >
                  {new Date(proposal.generatedAt).toLocaleTimeString()}
                </time>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <Detail
                  label="Reference"
                  value={formatCurrency(proposal.referencePrice)}
                />
                <Detail
                  label="Suggested limit"
                  value={formatCurrency(proposal.limitPrice)}
                  emphasis
                />
                <Detail
                  label="Quantity"
                  value={`${proposal.quantity} shares`}
                />
                <Detail
                  label="Risk budget"
                  value={formatPercent(proposal.riskPct)}
                />
                <Detail
                  label="Order terms"
                  value="Limit · DAY · Extended hours"
                  wide
                />
              </dl>

              <p className="mt-3 rounded-md bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-600">
                <span className="font-semibold text-slate-700">Signal: </span>
                {proposal.reason}
              </p>
              <p className="mt-2 text-[11px] font-medium text-amber-700">
                Proposal only — no order has been submitted.
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="p-6 text-center text-xs italic text-slate-400">{message}</p>
  );
}

function Detail({
  label,
  value,
  emphasis = false,
  wide = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className="uppercase tracking-wide text-[10px] font-semibold text-slate-400">
        {label}
      </dt>
      <dd
        className={
          emphasis ? "font-semibold text-emerald-700" : "text-slate-700"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}
