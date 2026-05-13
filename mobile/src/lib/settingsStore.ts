/**
 * Local-only mobile settings — PlanFlow API token + active project.
 *
 * The token landing here is interim: once T18.9 (auth screen) and T18.6
 * (WS bridge) are wired, the PWA will get a session token from the
 * desktop and proxy PlanFlow calls through the WebSocket. For T18.15 we
 * accept a user-pasted token so the task list view is testable end-to-end
 * before those upstream pieces land.
 */

const TOKEN_KEY = "ws.mobile.planflow.token";
const PROJECT_KEY = "ws.mobile.planflow.activeProjectId";

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore — Safari private mode, quota errors
  }
}

export const settingsStore = {
  getToken(): string | null {
    return safeGet(TOKEN_KEY);
  },
  setToken(token: string | null): void {
    safeSet(TOKEN_KEY, token);
  },
  getActiveProjectId(): string | null {
    return safeGet(PROJECT_KEY);
  },
  setActiveProjectId(id: string | null): void {
    safeSet(PROJECT_KEY, id);
  },
};
