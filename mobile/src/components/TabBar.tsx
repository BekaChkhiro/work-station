import { useLocation, useNavigate } from "@solidjs/router";
import { For, type JSX } from "solid-js";

type TabKey = "terminal" | "tasks" | "chat" | "projects" | "monitor";

interface Tab {
  key: TabKey;
  href: string;
  label: string;
  icon: () => JSX.Element;
}

const TABS: readonly Tab[] = [
  { key: "terminal", href: "/terminal", label: "Terminal", icon: TerminalIcon },
  { key: "tasks", href: "/tasks", label: "Tasks", icon: TasksIcon },
  { key: "chat", href: "/chat", label: "Chat", icon: ChatIcon },
  { key: "projects", href: "/projects", label: "Projects", icon: ProjectsIcon },
  { key: "monitor", href: "/monitor", label: "Monitor", icon: MonitorIcon },
];

const LAST_TAB_KEY = "ws.mobile.lastTab";

export function rememberTab(href: string) {
  try {
    localStorage.setItem(LAST_TAB_KEY, href);
  } catch {
    // ignore — Safari private mode etc.
  }
}

export function recallTab(): string {
  try {
    const v = localStorage.getItem(LAST_TAB_KEY);
    if (v && TABS.some((t) => t.href === v)) return v;
  } catch {
    // ignore
  }
  return "/terminal";
}

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (href: string) =>
    location.pathname === href || location.pathname.startsWith(`${href}/`);

  return (
    <nav
      class="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur"
      style={{ "padding-bottom": "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <ul class="mx-auto flex max-w-xl items-stretch justify-between">
        <For each={TABS}>
          {(tab) => {
            const active = () => isActive(tab.href);
            return (
              <li class="flex-1">
                <button
                  type="button"
                  onClick={() => {
                    rememberTab(tab.href);
                    navigate(tab.href);
                  }}
                  aria-current={active() ? "page" : undefined}
                  aria-label={tab.label}
                  class={`flex h-[56px] w-full min-h-[44px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none transition-colors ${
                    active() ? "text-cyan-400" : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  <span
                    class={`flex h-5 items-center justify-center ${
                      active() ? "opacity-100" : "opacity-80"
                    }`}
                    aria-hidden="true"
                  >
                    {tab.icon()}
                  </span>
                  <span>{tab.label}</span>
                  <span
                    class={`mt-0.5 h-0.5 w-6 rounded-full transition-colors ${
                      active() ? "bg-cyan-400" : "bg-transparent"
                    }`}
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </nav>
  );
}

function TerminalIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="3 12 7 12 10 5 14 19 17 12 21 12" />
    </svg>
  );
}
