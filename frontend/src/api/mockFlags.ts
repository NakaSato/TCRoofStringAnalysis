/**
 * Pages that run on an in-memory mock until the backend has their routes (`api/toolsMock.ts`,
 * `api/claimsMock.ts`). Kept apart from the mocks so the sidebar and the "Claim" links can check them
 * without loading mock code. On in dev or when built with `VITE_TOOLS_MOCK=1` / `VITE_CLAIMS_MOCK=1`
 * (the production build sets them from `TOOLS_MOCK` / `CLAIMS_MOCK` in `deploy/gcp.config`). Off = the
 * page and its links are hidden: there is no backend to answer them yet.
 */
export const TOOLS_MOCK: boolean = import.meta.env.DEV || import.meta.env.VITE_TOOLS_MOCK === "1";
export const CLAIMS_MOCK: boolean = import.meta.env.DEV || import.meta.env.VITE_CLAIMS_MOCK === "1";

const resets: Array<() => void> = [];

/** a mock's tab-memory state is dropped on sign-out: the next user may see other plants */
export function onMockReset(fn: () => void): void {
  resets.push(fn);
}

export function resetMocks(): void {
  resets.forEach((fn) => fn());
}
