# Project Guidelines & Architecture

## Tech Stack & Architecture
- Framework: Next.js (App Router, React Server Components by default)
- Language: TypeScript 5+ (Strict mode enabled, no explicit `any`)
- Styling: Tailwind CSS, Radix UI primitives
- State: Zustand (global client state), TanStack Query (server/API state)
- Testing: Vitest (unit/integration), Playwright (E2E)

## Component & File Structure
- use /schema.md for file hierarchy
- Push `'use client'` boundaries as far down the component tree as possible. Default to Server Components for data fetching and layout structure.
- Component Exports: Use named exports (`export function FeatureCard()`). Reserve default exports exclusively for Next.js routing files (`page.tsx`, `layout.tsx`).
- Imports: Always use absolute path aliases (`@/components/...`, `@/lib/...`). Group imports: 1) React/Next, 2) Third-party, 3) Internal components, 4) Utils/Types.

## Type Safety & Anti-Patterns
- Strict Typing: Never use `any` or `unknown` without explicit narrowing. Define precise interfaces for component props.
- No Direct `useEffect` Fetching: Use TanStack Query or Server Actions for async data management.
- Immutability: Mutating state directly is strictly forbidden; always use immutable update patterns.
- Error Handling: Wrap API routes and Server Actions in standardized error handling wrappers (`@/lib/api-response.ts`).

## Agent Guardrails & Workflow Safety
- Terminal Commands: Never execute destructive shell commands (`rm -rf`, force pushes, schema drops) without confirmation.
- Dependencies: Do not add or upgrade `package.json` dependencies without asking first.
- Verification Step: After writing or refactoring code, run `npm run typecheck` and `npm run lint` mentally or via terminal execution to ensure zero errors remain.v