import React, { useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, Sun } from "lucide-react";
import { useAppContext } from "../context/AppContext";

/** Full-screen sign-in, shown whenever there is no valid session. Username + password only. */
export const LoginPage: React.FC = () => {
  const { loginAs } = useAppContext();
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
      setError(err instanceof Error ? err.message : "Sign in failed");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 text-slate-200">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="rounded-xl bg-solar-500 p-2.5 text-ink-950">
            <Sun className="h-6 w-6" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-lg font-extrabold tracking-tight text-white">GenZ Monitoring</div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-solar-400/80">Control Center</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="panel space-y-4 p-6" noValidate>
          <div>
            <h1 className="text-base font-semibold text-white">Sign in</h1>
            <p className="mt-0.5 text-xs text-slate-500">Use the username and password from your administrator.</p>
          </div>

          <div>
            <label htmlFor="login-username" className="label">
              Username
            </label>
            <input
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
              className="input"
              required
            />
          </div>

          <div>
            <label htmlFor="login-password" className="label">
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pr-9"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-500 hover:text-slate-300"
                aria-label={showPassword ? "Hide password" : "Show password"}
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

          <button
            type="submit"
            className="btn-primary w-full justify-center"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
