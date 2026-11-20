/**
 * Pages that run on an in-memory mock until the backend has their routes (`api/toolsMock.ts`).
 * Kept apart from the mock so the sidebar can check it without loading mock code. On in dev or when
 * built with `VITE_TOOLS_MOCK=1` (the production build sets it from `TOOLS_MOCK` in
 * `deploy/gcp.config`). Off = the page is hidden: there is no backend to answer it yet.
 */
export const TOOLS_MOCK: boolean = import.meta.env.DEV || import.meta.env.VITE_TOOLS_MOCK === "1";

const resets: Array<() => void> = [];

/** a mock's tab-memory state is dropped on sign-out: the next user may see other plants */
export function onMockReset(fn: () => void): void {
  resets.push(fn);
}

export function resetMocks(): void {
  resets.forEach((fn) => fn());
}
