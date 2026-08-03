// app/providers.tsx
// Root Client Component that wraps the application in all necessary providers.
// Kept as a thin wrapper so the root layout can remain a Server Component.
//
// Providers mounted here:
//   - QueryClientProvider (TanStack Query)
//   - EngineSocketProvider (Socket.IO → Zustand store)

"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { queryClient } from "@/lib/query-client";
import { useEngineSocket } from "@/hooks/useEngineSocket";
import type { ReactNode } from "react";

function EngineSocketProvider({ children }: { children: ReactNode }) {
  // Mount the socket listener once at the top of the tree
  useEngineSocket();
  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <EngineSocketProvider>{children}</EngineSocketProvider>
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
