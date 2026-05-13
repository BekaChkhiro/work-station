import type { JSX } from "solid-js";
import { TabBar } from "./TabBar";

export function Shell(props: { children?: JSX.Element }) {
  return (
    <div class="min-h-screen bg-neutral-950 text-neutral-100">
      <main
        class="mx-auto max-w-xl"
        style={{
          "padding-top": "env(safe-area-inset-top)",
          "padding-left": "env(safe-area-inset-left)",
          "padding-right": "env(safe-area-inset-right)",
          "padding-bottom": "calc(env(safe-area-inset-bottom) + 72px)",
        }}
      >
        {props.children}
      </main>
      <TabBar />
    </div>
  );
}
