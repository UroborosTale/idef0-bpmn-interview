import { useState } from "react";
import { api } from "../api/client";

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (login: string) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(login.trim(), password);
      onLoggedIn(r.user.login);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>IDEF0 / BPMN — вход</h3>
        <label>
          Логин
          <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label>
          Пароль
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="validation-item error">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !login || !password}>
          Войти
        </button>
      </form>
    </div>
  );
}
