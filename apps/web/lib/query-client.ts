// lib/query-client.ts
// Shared TanStack Query client singleton.
// Imported by the QueryClientProvider in the root layout so all hooks
// share the same cache across the app.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 10 seconds before a background refetch
      staleTime: 10_000,
      // Keep unused query data in cache for 5 minutes
      gcTime: 5 * 60 * 1_000,
      // Retry failed queries once before surfacing the error
      retry: 1,
    },
  },
});
