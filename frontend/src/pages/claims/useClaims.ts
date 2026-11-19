/** Claims data: the claim list, read on mount, after each change and every 5 min while the page is
 * visible. DB only. Uses the in-memory mock while `CLAIMS_MOCK` is on (see `api/claimsMock.ts`). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { ClaimList } from "../../api/client";
import { CLAIMS_MOCK, claimsMock } from "../../api/claimsMock";
import { useAppContext } from "../../context/AppContext";

/** the API the page uses: the real client, or the mock with the same signatures */
export const claimsApi = CLAIMS_MOCK
  ? claimsMock
  : {
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
  const { growattPlants } = useAppContext();
  const [data, setData] = useState<ClaimList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // mock only: seed the example claims on the user's own plants
  const plantKey = growattPlants
    .slice(0, 5)
    .map((p) => p.plant_id)
    .join(",");
  const seedKey = CLAIMS_MOCK ? plantKey : "";
  if (CLAIMS_MOCK && growattPlants.length) claimsMock.setPlants(growattPlants.slice(0, 5).map((p) => ({ id: p.plant_id, name: p.name })));

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
    // seedKey: the mock seeds again once the plant list arrives, so read again then
  }, [reload, seedKey]);

  return { data, loading, error, reload, mock: CLAIMS_MOCK };
}
