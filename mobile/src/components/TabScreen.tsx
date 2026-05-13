export function TabScreen(props: { title: string; hint: string }) {
  return (
    <section class="flex min-h-[calc(100vh-128px)] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 class="text-2xl font-semibold tracking-tight">{props.title}</h1>
      <p class="max-w-sm text-sm text-neutral-400">{props.hint}</p>
    </section>
  );
}
