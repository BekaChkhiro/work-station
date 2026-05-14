import { Show, createSignal, type JSX } from "solid-js";
import { authStore, connect } from "../lib/auth";
import { ScanQrSheet } from "./ScanQrSheet";

interface AuthScreenProps {
  /** Pre-fill the form — used by Settings to re-edit current credentials. */
  initialHost?: string;
  initialToken?: string;
  /** Cosmetic — "Connect" vs "Save & reconnect". */
  submitLabel?: string;
  /** Optional dismiss for modal/sheet use; absent on the first-launch screen. */
  onCancel?: () => void;
  /** Inline mode skips the centred shell so a parent sheet can host it. */
  inline?: boolean;
}

export function AuthScreen(props: AuthScreenProps) {
  const [host, setHost] = createSignal(props.initialHost ?? authStore.host());
  const [token, setToken] = createSignal(props.initialToken ?? authStore.token());
  const [scanOpen, setScanOpen] = createSignal(false);

  const status = authStore.status;
  const busy = () => status().kind === "connecting";
  const canSubmit = () => !busy() && host().trim().length > 0 && token().trim().length > 0;

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (!canSubmit()) return;
    await connect(host(), token());
  }

  const card = (
    <form
      class="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border-default bg-surface p-6"
      onSubmit={handleSubmit}
      aria-busy={busy()}
    >
      <header class="flex flex-col items-center gap-2 text-center">
        <div class="text-3xl leading-none text-accent" aria-hidden="true">
          ▣
        </div>
        <h1 class="text-xl font-semibold tracking-tight">Connect to Work Station</h1>
        <p class="max-w-xs text-sm text-fg-secondary">
          Scan the pairing QR from desktop Settings, or paste the host + token below.
        </p>
      </header>

      <button
        type="button"
        onClick={() => setScanOpen(true)}
        disabled={busy()}
        class="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-accent/60 bg-accent/10 px-3 text-sm font-semibold text-accent hover:bg-accent/15 disabled:opacity-60"
      >
        <ScanIcon />
        Scan pairing QR
      </button>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium uppercase tracking-wider text-fg-tertiary">Host</span>
        <input
          type="url"
          value={host()}
          onInput={(e) => setHost(e.currentTarget.value)}
          placeholder="http://localhost:7420"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          inputmode="url"
          spellcheck={false}
          disabled={busy()}
          class="min-h-[44px] rounded-lg border border-border-default bg-elevated px-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring disabled:opacity-60"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium uppercase tracking-wider text-fg-tertiary">Token</span>
        <input
          type="password"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          placeholder="Paste 43-character token"
          autocapitalize="none"
          autocomplete="one-time-code"
          autocorrect="off"
          spellcheck={false}
          disabled={busy()}
          class="min-h-[44px] rounded-lg border border-border-default bg-elevated px-3 font-mono text-base tracking-tight outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring disabled:opacity-60"
        />
      </label>

      <StatusBanner />

      <div class="mt-1 flex gap-2">
        <Show when={props.onCancel}>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={busy()}
            class="flex-1 min-h-[44px] rounded-lg border border-border-default bg-transparent font-medium text-fg-secondary hover:bg-hover disabled:opacity-60"
          >
            Cancel
          </button>
        </Show>
        <button
          type="submit"
          disabled={!canSubmit()}
          class="flex-1 min-h-[44px] rounded-lg bg-accent font-semibold text-white hover:bg-accent-muted disabled:opacity-50"
        >
          {busy() ? "Connecting…" : (props.submitLabel ?? "Connect")}
        </button>
      </div>
    </form>
  );

  const scanner = (
    <Show when={scanOpen()}>
      <ScanQrSheet
        onClose={() => setScanOpen(false)}
        onResult={(payload) => {
          setHost(payload.host);
          setToken(payload.token);
          setScanOpen(false);
          void connect(payload.host, payload.token);
        }}
      />
    </Show>
  );

  if (props.inline) {
    return (
      <>
        {card}
        {scanner}
      </>
    );
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-canvas px-4 py-6">
      {card}
      {scanner}
    </div>
  );
}

function ScanIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <rect x="7" y="7" width="10" height="10" rx="1" />
    </svg>
  );
}

function StatusBanner() {
  const status = authStore.status;
  return (
    <Show when={status().kind !== "idle"}>
      <div
        role="status"
        aria-live="polite"
        class={`rounded-lg px-3.5 py-3 text-sm ${bannerClass(status())}`}
      >
        {bannerText(status())}
      </div>
    </Show>
  );
}

function bannerText(status: ReturnType<typeof authStore.status>): JSX.Element {
  switch (status.kind) {
    case "connecting":
      return "Checking host and token…";
    case "connected":
      return "Connected.";
    case "error":
      return status.message;
    default:
      return null;
  }
}

function bannerClass(status: ReturnType<typeof authStore.status>): string {
  switch (status.kind) {
    case "connected":
      return "bg-success/10 text-success";
    case "error":
      return "bg-error/10 text-error";
    case "connecting":
    default:
      return "bg-accent-soft text-accent";
  }
}
