import { createSignal, For } from "solid-js";
import { Button, Dialog, Tabs } from "@kobalte/core";
import { theme, setTheme, toggleTheme } from "./stores/theme";

/*
 * Design System Showcase — Work Station
 * Temporary demo page that exercises colors, typography, spacing,
 * motion, and Kobalte primitives. Will be replaced by real layout
 * once later tasks land.
 */

const THEME_OPTIONS: Array<"dark" | "light" | "system"> = [
  "dark",
  "light",
  "system",
];

const COLOR_SWATCHES = [
  { name: "Primary 500", class: "bg-primary-500" },
  { name: "Primary 400", class: "bg-primary-400" },
  { name: "Success", class: "bg-success" },
  { name: "Warning", class: "bg-warning" },
  { name: "Danger", class: "bg-danger" },
  { name: "Info", class: "bg-info" },
];

const SPACING_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

export default function App() {
  const [dialogOpen, setDialogOpen] = createSignal(false);

  return (
    <div class="min-h-screen bg-surface-base text-text-primary p-8 font-sans">
      <header class="mb-10">
        <h1 class="text-3xl font-bold tracking-tight mb-2">
          Work Station
        </h1>
        <p class="text-text-secondary text-base">
          Design system foundation — T1.4
        </p>
      </header>

      <Tabs.Root class="max-w-3xl">
        <Tabs.List class="flex gap-1 border-b border-surface-border mb-6">
          <For each={["Theme", "Colors", "Spacing", "Typography", "Components"]}>
            {(label) => (
              <Tabs.Trigger
                value={label.toLowerCase()}
                class="px-4 py-2 text-sm font-medium text-text-secondary rounded-t-md
                       hover:bg-surface-hover hover:text-text-primary
                       data-[selected]:text-text-accent data-[selected]:border-b-2
                       data-[selected]:border-primary-500 transition-colors duration-fast"
              >
                {label}
              </Tabs.Trigger>
            )}
          </For>
        </Tabs.List>

        {/* ── Theme tab ── */}
        <Tabs.Content value="theme" class="space-y-6">
          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
            <h2 class="text-lg font-semibold mb-4">Active theme</h2>
            <p class="text-text-secondary mb-4">
              Current: <span class="font-mono text-text-primary">{theme()}</span>
            </p>
            <div class="flex gap-3 mb-6">
              <For each={THEME_OPTIONS}>
                {(t) => (
                  <button
                    onClick={() => setTheme(t)}
                    class={`px-4 py-2 rounded-md text-sm font-medium border transition-all duration-fast
                      ${
                        theme() === t
                          ? "bg-primary-500/15 border-primary-500 text-text-accent"
                          : "bg-transparent border-surface-border text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      }`}
                  >
                    {t}
                  </button>
                )}
              </For>
            </div>
            <Button.Root
              onClick={toggleTheme}
              class="px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-md
                     text-sm font-medium transition-colors duration-fast shadow-sm"
            >
              Toggle dark / light
            </Button.Root>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
              <h3 class="text-sm font-semibold text-text-secondary mb-2">
                Surface Elevated
              </h3>
              <p class="text-text-tertiary text-sm">
                Cards, modals, and popovers use this surface.
              </p>
            </div>
            <div class="bg-surface-sunken border border-surface-border-subtle rounded-lg p-6">
              <h3 class="text-sm font-semibold text-text-secondary mb-2">
                Surface Sunken
              </h3>
              <p class="text-text-tertiary text-sm">
                Input fields and inset panels use this surface.
              </p>
            </div>
          </div>
        </Tabs.Content>

        {/* ── Colors tab ── */}
        <Tabs.Content value="colors" class="space-y-6">
          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
            <h2 class="text-lg font-semibold mb-4">Semantic palette</h2>
            <div class="grid grid-cols-3 gap-4">
              <For each={COLOR_SWATCHES}>
                {(swatch) => (
                  <div class="flex items-center gap-3">
                    <div
                      class={`w-10 h-10 rounded-md ${swatch.class} shadow-sm`}
                    />
                    <span class="text-sm text-text-secondary">{swatch.name}</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
            <h2 class="text-lg font-semibold mb-4">Neutral scale</h2>
            <div class="flex gap-2">
              <For each={[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]}>
                {(n) => (
                  <div class="flex-1 flex flex-col items-center gap-1">
                    <div
                      class={`w-full h-10 rounded-md bg-neutral-${n}`}
                      style={{ background: `var(--color-neutral-${n})` }}
                    />
                    <span class="text-[10px] text-text-tertiary font-mono">
                      {n}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Tabs.Content>

        {/* ── Spacing tab ── */}
        <Tabs.Content value="spacing" class="space-y-6">
          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
            <h2 class="text-lg font-semibold mb-4">4-px grid scale</h2>
            <div class="space-y-3">
              <For each={SPACING_STEPS}>
                {(n) => (
                  <div class="flex items-center gap-4">
                    <span class="w-12 text-right text-xs text-text-tertiary font-mono">
                      {n}
                    </span>
                    <div
                      class="h-4 bg-primary-500 rounded-sm"
                      style={{ width: `${n * 4}px` }}
                    />
                    <span class="text-xs text-text-tertiary">
                      {n * 4}px
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Tabs.Content>

        {/* ── Typography tab ── */}
        <Tabs.Content value="typography" class="space-y-6">
          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6 space-y-4">
            <h2 class="text-lg font-semibold mb-2">Type scale</h2>
            <p class="text-3xl font-bold">3xl — Page title</p>
            <p class="text-2xl font-semibold">2xl — Section heading</p>
            <p class="text-xl font-semibold">xl — Sub-section</p>
            <p class="text-lg font-medium">lg — Card title</p>
            <p class="text-md">md — Body emphasis</p>
            <p class="text-base">base — Default body text</p>
            <p class="text-sm">sm — Secondary text, labels</p>
            <p class="text-xs">xs — Captions, badges</p>
          </div>

          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6">
            <h2 class="text-lg font-semibold mb-2">Font stacks</h2>
            <p class="font-sans text-base mb-2">
              Sans-serif — UI chrome, labels, buttons
            </p>
            <p class="font-mono text-base text-text-secondary">
              Monospace — Terminal output, paths, hashes
            </p>
          </div>
        </Tabs.Content>

        {/* ── Components tab ── */}
        <Tabs.Content value="components" class="space-y-6">
          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6 space-y-4">
            <h2 class="text-lg font-semibold">Kobalte primitives</h2>

            <div class="flex gap-3">
              <Button.Root class="px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-md text-sm font-medium transition-colors duration-fast">
                Primary button
              </Button.Root>
              <Button.Root class="px-4 py-2 bg-surface-hover hover:bg-surface-active border border-surface-border rounded-md text-sm font-medium transition-colors duration-fast">
                Secondary button
              </Button.Root>
              <Button.Root
                disabled
                class="px-4 py-2 bg-surface-sunken text-text-disabled rounded-md text-sm font-medium cursor-not-allowed"
              >
                Disabled
              </Button.Root>
            </div>

            <div>
              <Button.Root
                onClick={() => setDialogOpen(true)}
                class="px-4 py-2 bg-surface-hover hover:bg-surface-active border border-surface-border rounded-md text-sm font-medium transition-colors duration-fast"
              >
                Open Dialog
              </Button.Root>

              <Dialog.Root open={dialogOpen()} onOpenChange={setDialogOpen}>
                <Dialog.Portal>
                  <Dialog.Overlay class="fixed inset-0 bg-surface-overlay z-50 data-[expanded]:animate-in data-[closed]:animate-out" />
                  <Dialog.Content class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50
                                         bg-surface-elevated border border-surface-border rounded-xl p-6 shadow-xl
                                         w-full max-w-md data-[expanded]:animate-in data-[closed]:animate-out">
                    <div class="flex items-center justify-between mb-4">
                      <Dialog.Title class="text-lg font-semibold">
                        Design token preview
                      </Dialog.Title>
                      <Dialog.CloseButton class="text-text-tertiary hover:text-text-primary transition-colors">
                        ✕
                      </Dialog.CloseButton>
                    </div>
                    <Dialog.Description class="text-text-secondary text-sm mb-6">
                      This dialog uses Kobalte&apos;s Dialog primitive with
                      custom Tailwind styling. All motion and focus management
                      is handled by the primitive.
                    </Dialog.Description>
                    <div class="flex justify-end gap-3">
                      <Dialog.CloseButton class="px-4 py-2 bg-surface-hover hover:bg-surface-active border border-surface-border rounded-md text-sm font-medium transition-colors">
                        Cancel
                      </Dialog.CloseButton>
                      <Dialog.CloseButton class="px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-md text-sm font-medium transition-colors">
                        Confirm
                      </Dialog.CloseButton>
                    </div>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            </div>
          </div>

          <div class="bg-surface-elevated border border-surface-border rounded-lg p-6 space-y-3">
            <h2 class="text-lg font-semibold">Motion tokens</h2>
            <div class="flex gap-4">
              <div
                class="w-16 h-16 bg-primary-500 rounded-md hover:scale-110 transition-transform duration-fast ease-out"
                title="duration-fast + ease-out"
              />
              <div
                class="w-16 h-16 bg-primary-500 rounded-md hover:scale-110 transition-transform duration-normal ease-out"
                title="duration-normal + ease-out"
              />
              <div
                class="w-16 h-16 bg-primary-500 rounded-md hover:scale-110 transition-transform duration-slow ease-spring"
                title="duration-slow + ease-spring"
              />
            </div>
            <p class="text-xs text-text-tertiary">
              Hover each square to see the motion token in action.
            </p>
          </div>
        </Tabs.Content>
      </Tabs.Root>

      <footer class="mt-16 pt-6 border-t border-surface-border text-xs text-text-tertiary">
        Work Station v0.1.0 — Tauri 2 + Solid + Tailwind CSS v4 + Kobalte
      </footer>
    </div>
  );
}
