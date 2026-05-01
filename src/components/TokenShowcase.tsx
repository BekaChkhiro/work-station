import { For, type JSX } from "solid-js";
import { themeMode, resolvedTheme, setThemeMode, type ThemeMode } from "../stores/theme";

const SectionTitle = (props: { children: JSX.Element }) => (
  <h2 class="text-xl font-semibold tracking-tight text-fg mt-8 mb-4">{props.children}</h2>
);

const Card = (props: { children: JSX.Element; class?: string }) => (
  <div class={`rounded-md border border-border-default bg-surface p-4 ${props.class ?? ""}`}>
    {props.children}
  </div>
);

const Swatch = (props: { name: string; varName: string; hex?: string }) => (
  <div class="flex items-center gap-3 rounded-sm border border-border-subtle bg-elevated p-2">
    <div
      class="h-8 w-8 shrink-0 rounded-sm border border-border-default"
      style={{ background: `var(${props.varName})` }}
      aria-hidden="true"
    />
    <div class="min-w-0">
      <div class="truncate text-sm text-fg">{props.name}</div>
      <div class="truncate font-mono text-xs text-fg-tertiary">{props.varName}</div>
    </div>
  </div>
);

const ThemePicker = () => {
  const options: { id: ThemeMode; label: string }[] = [
    { id: "dark", label: "Dark" },
    { id: "light", label: "Light" },
    { id: "system", label: "System" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      class="inline-flex rounded-md border border-border-default bg-surface p-1"
    >
      <For each={options}>
        {(opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={themeMode() === opt.id}
            onClick={() => setThemeMode(opt.id)}
            class={
              themeMode() === opt.id
                ? "rounded-sm bg-accent-soft px-3 py-1 text-sm text-accent transition-colors"
                : "rounded-sm px-3 py-1 text-sm text-fg-secondary transition-colors hover:text-fg"
            }
          >
            {opt.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default function TokenShowcase() {
  const bgs: { name: string; v: string }[] = [
    { name: "bg.canvas", v: "--bg-canvas" },
    { name: "bg.surface", v: "--bg-surface" },
    { name: "bg.elevated", v: "--bg-elevated" },
    { name: "bg.terminal", v: "--bg-terminal" },
    { name: "bg.titlebar", v: "--bg-titlebar" },
  ];
  const borders: { name: string; v: string }[] = [
    { name: "border.subtle", v: "--border-subtle" },
    { name: "border.default", v: "--border-default" },
    { name: "border.strong", v: "--border-strong" },
    { name: "border.focus", v: "--border-focus" },
  ];
  const texts: { name: string; v: string }[] = [
    { name: "text.primary", v: "--text-primary" },
    { name: "text.secondary", v: "--text-secondary" },
    { name: "text.tertiary", v: "--text-tertiary" },
    { name: "text.terminal", v: "--text-terminal" },
  ];
  const accents: { name: string; v: string }[] = [
    { name: "accent", v: "--accent" },
    { name: "accent.muted", v: "--accent-muted" },
    { name: "accent.soft", v: "--accent-soft" },
    { name: "accent.ring", v: "--accent-ring" },
  ];
  const semantics: { name: string; v: string }[] = [
    { name: "success", v: "--success" },
    { name: "warning", v: "--warning" },
    { name: "error", v: "--error" },
    { name: "info", v: "--info" },
  ];
  const swatches = Array.from({ length: 8 }, (_, i) => ({
    name: `swatch-${i + 1}`,
    v: `--swatch-${i + 1}`,
  }));
  const sizes = [11, 12, 13, 14, 16, 20, 24] as const;
  const spaces = [4, 8, 12, 16, 20, 24, 32, 48] as const;
  const radii: { name: string; v: string }[] = [
    { name: "sm (4px)", v: "--r-sm" },
    { name: "md (6px)", v: "--r-md" },
    { name: "lg (8px)", v: "--r-lg" },
  ];

  return (
    <div class="mx-auto max-w-5xl px-6 py-10 text-fg">
      <header class="flex items-end justify-between gap-4 border-b border-border-subtle pb-6">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Work Station — Design Tokens</h1>
          <p class="mt-1 text-sm text-fg-secondary">
            T1.4 foundation. Resolved theme:{" "}
            <span class="font-mono text-fg">{resolvedTheme()}</span> · Mode:{" "}
            <span class="font-mono text-fg">{themeMode()}</span>
          </p>
        </div>
        <ThemePicker />
      </header>

      <SectionTitle>Surfaces</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
          <For each={bgs}>{(s) => <Swatch name={s.name} varName={s.v} />}</For>
        </div>
      </Card>

      <SectionTitle>Borders</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <For each={borders}>{(s) => <Swatch name={s.name} varName={s.v} />}</For>
        </div>
      </Card>

      <SectionTitle>Text</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <For each={texts}>{(s) => <Swatch name={s.name} varName={s.v} />}</For>
        </div>
        <div class="mt-4 space-y-1 border-t border-border-subtle pt-4">
          <p class="text-fg">The quick brown fox — text.primary</p>
          <p class="text-fg-secondary">The quick brown fox — text.secondary</p>
          <p class="text-fg-tertiary">The quick brown fox — text.tertiary</p>
          <p class="font-mono text-fg-terminal">$ claude --version — text.terminal (mono)</p>
        </div>
      </Card>

      <SectionTitle>Accent</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <For each={accents}>{(s) => <Swatch name={s.name} varName={s.v} />}</For>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
          <button class="rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-canvas transition-[filter] hover:brightness-110">
            Primary action
          </button>
          <button class="rounded-sm border border-border-default bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-hover">
            Secondary
          </button>
          <button class="rounded-sm bg-accent-soft px-3 py-1.5 text-sm text-accent">Soft</button>
          <span class="rounded-sm border border-border-focus bg-accent-soft px-2 py-1 font-mono text-xs text-accent">
            focus ring
          </span>
        </div>
      </Card>

      <SectionTitle>Semantic</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <For each={semantics}>{(s) => <Swatch name={s.name} varName={s.v} />}</For>
        </div>
      </Card>

      <SectionTitle>Project swatches</SectionTitle>
      <Card>
        <div class="grid grid-cols-4 gap-2 md:grid-cols-8">
          <For each={swatches}>
            {(s) => (
              <div class="flex flex-col items-center gap-1">
                <div
                  class="h-10 w-10 rounded-md border border-border-default"
                  style={{ background: `var(${s.v})` }}
                  aria-label={s.name}
                />
                <span class="font-mono text-xs text-fg-tertiary">{s.name}</span>
              </div>
            )}
          </For>
        </div>
      </Card>

      <SectionTitle>Typography</SectionTitle>
      <Card>
        <div class="space-y-2">
          <For each={sizes}>
            {(px) => (
              <div class="flex items-baseline gap-4">
                <span class="w-12 font-mono text-xs text-fg-tertiary">{px}px</span>
                <span style={{ "font-size": `${px}px` }}>Quiet, confident, fast.</span>
              </div>
            )}
          </For>
          <div class="mt-4 border-t border-border-subtle pt-4">
            <div class="flex items-baseline gap-4">
              <span class="w-12 font-mono text-xs text-fg-tertiary">mono</span>
              <span class="font-mono text-base">$ pnpm tauri dev — 0123456789</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="w-12 font-mono text-xs text-fg-tertiary">tnum</span>
              <span class="tabular font-mono text-base">01:23 · 12:00 · 99:99</span>
            </div>
          </div>
        </div>
      </Card>

      <SectionTitle>Spacing</SectionTitle>
      <Card>
        <div class="space-y-2">
          <For each={spaces}>
            {(px) => (
              <div class="flex items-center gap-4">
                <span class="w-12 font-mono text-xs text-fg-tertiary">{px}px</span>
                <div class="h-3 rounded-sm bg-accent-soft" style={{ width: `${px}px` }} />
              </div>
            )}
          </For>
        </div>
      </Card>

      <SectionTitle>Radius</SectionTitle>
      <Card>
        <div class="grid grid-cols-3 gap-3">
          <For each={radii}>
            {(r) => (
              <div class="flex flex-col items-center gap-2">
                <div
                  class="h-16 w-16 border border-border-default bg-elevated"
                  style={{ "border-radius": `var(${r.v})` }}
                />
                <span class="font-mono text-xs text-fg-tertiary">{r.name}</span>
              </div>
            )}
          </For>
        </div>
      </Card>

      <SectionTitle>Motion</SectionTitle>
      <Card>
        <p class="mb-3 text-sm text-fg-secondary">
          150ms / 100ms / 200ms — collapses to 0ms under{" "}
          <span class="font-mono text-fg">prefers-reduced-motion</span>.
        </p>
        <div class="group flex flex-wrap items-center gap-3">
          <div
            class="h-10 w-10 rounded-md bg-accent-muted transition-transform"
            style={{
              "transition-duration": "var(--dur-base)",
              "transition-timing-function": "var(--ease)",
            }}
            classList={{ "translate-x-12": false }}
          />
          <button
            class="rounded-sm border border-border-default bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-hover"
            onClick={(e) => {
              const el = e.currentTarget.previousElementSibling as HTMLElement | null;
              if (!el) return;
              el.classList.toggle("translate-x-12");
            }}
          >
            Animate
          </button>
        </div>
      </Card>

      <SectionTitle>Elevation</SectionTitle>
      <Card>
        <div class="grid grid-cols-2 gap-4">
          <div
            class="rounded-md border border-border-default bg-elevated p-4"
            style={{ "box-shadow": "var(--shadow-popover)" }}
          >
            <div class="text-sm text-fg">popover</div>
            <div class="font-mono text-xs text-fg-tertiary">shadow-popover</div>
          </div>
          <div
            class="rounded-lg border border-border-default bg-elevated p-4"
            style={{ "box-shadow": "var(--shadow-modal)" }}
          >
            <div class="text-sm text-fg">modal</div>
            <div class="font-mono text-xs text-fg-tertiary">shadow-modal</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
