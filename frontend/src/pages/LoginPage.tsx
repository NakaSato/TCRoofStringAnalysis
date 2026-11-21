import React, { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { LanguageToggle, useI18n } from "../i18n";

/** Full-screen sign-in, shown whenever there is no valid session. Username + password only. */
export const LoginPage: React.FC = () => {
  const { loginAs } = useAppContext();
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await loginAs(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Sign in failed"));
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 text-slate-200">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-end">
          <LanguageToggle />
        </div>
        <div className="mb-8 flex items-center justify-center text-center">
          <div>
            <div className="text-2xl font-extrabold tracking-tight text-white">GenZ Monitoring</div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-solar-400/80">{t("Control Center")}</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="panel space-y-4 p-6" noValidate>
          <div>
            <h1 className="text-base font-semibold text-white">{t("Sign in")}</h1>
            <p className="mt-0.5 text-xs text-slate-500">{t("Use the username and password from your administrator.")}</p>
          </div>

          <div>
            <Label htmlFor="login-username" className="mb-1 block text-[11px] font-medium text-slate-400">
              {t("Username")}
            </Label>
            <Input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div>
            <Label htmlFor="login-password" className="mb-1 block text-[11px] font-medium text-slate-400">
              {t("Password")}
            </Label>
            <div className="relative">
              <Input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-9"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-500 hover:text-slate-300"
                aria-label={showPassword ? t("Hide password") : t("Show password")}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="callout-crit" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="default"
            className="w-full justify-center"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? <Spinner data-icon="inline-start" className="text-current" /> : <LogIn data-icon="inline-start" className="h-4 w-4" />}
            {submitting ? t("Signing in…") : t("Sign in")}
          </Button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
