/** Claims data: the claim list, read on mount, after each change and every 5 min while the page is
 * visible. DB only (`/claims`, docs/plans/claims.md). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { ClaimList } from "../../api/client";

/** the claim methods the page uses */
export const claimsApi = {
  listClaims: api.listClaims,
  getClaim: api.getClaim,
  createClaim: api.createClaim,
  patchClaim: api.patchClaim,
  deleteClaim: api.deleteClaim,
  setClaimStatus: api.setClaimStatus,
  addClaimEvent: api.addClaimEvent,
  setClaimEvidence: api.setClaimEvidence,
  addClaimLink: api.addClaimLink,
  deleteClaimLink: api.deleteClaimLink,
};

const REFRESH_MS = 5 * 60_000;

export function useClaims() {
  const [data, setData] = useState<ClaimList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await claimsApi.listClaims();
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  return { data, loading, error, reload };
}
