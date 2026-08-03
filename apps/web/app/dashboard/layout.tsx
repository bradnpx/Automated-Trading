// app/dashboard/layout.tsx
// Dashboard layout — Server Component.
// Wraps all dashboard pages in the Providers Client Component so that
// TanStack Query and the Socket.IO store are available to all children.

import { Providers } from "@/app/providers";
import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
