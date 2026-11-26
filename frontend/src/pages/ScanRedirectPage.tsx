import React, { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { ApiError, api, type ScanResolve } from "../api/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadingState } from "../components/ui";
import { useI18n } from "../i18n";

/**
 * `/s/:kind/:code`: an app label opened by a phone's own camera app or a pasted link
 * (docs/plans/barcode-scanning.md §7.1). Resolved like a scan; one match redirects there. Signed out,
 * the login page shows first and the same URL opens after sign-in (AuthGate).
 */
export const ScanRedirectPage: React.FC = () => {
  const { kind = "", code = "" } = useParams();
  const { t } = useI18n();
  const [res, setRes] = useState<ScanResolve | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRes(null);
    setError(null);
    api
      .resolveScan(`${kind}:${code}`)
      .then((r) => alive && setRes(r))
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ApiError && e.status === 404 ? t("Not found, or not on one of your plants.") : e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [kind, code, t]);

  if (res?.matches.length === 1) return <Navigate to={res.matches[0].path} replace />;
  if (!res && !error) return <LoadingState label={t("Opening the label…")} />;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScanLine className="size-4 text-slate-500" aria-hidden />
            {t("Label")}
            <Badge variant="neutral" className="font-mono">
              {kind}:{code}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <EmptyState title={error} />
          ) : res && res.matches.length > 1 ? (
            <ul className="flex flex-col gap-1.5">
              {res.matches.map((m) => (
                <li key={`${m.kind}-${m.id}`}>
                  <Link to={m.path} className="block rounded-md border border-white/[0.07] px-3 py-2 text-xs hover:border-white/20">
                    <span className="font-medium text-slate-100">{m.label}</span>
                    <span className="block text-muted-foreground">{[m.plant_name, m.detail].filter(Boolean).join(" · ") || "—"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title={res?.unsupported_kind ? t("This kind of label is not in the app yet.") : t("Nothing in the app has this code.")}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
};
