import { authStore, signOut } from "../lib/auth";
import { AuthScreen } from "./AuthScreen";

export function SettingsSheet(props: { onClose: () => void }) {
  function handleSignOut() {
    signOut();
    props.onClose();
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="flex w-full max-w-md flex-col gap-3">
        <AuthScreen
          inline
          initialHost={authStore.host()}
          initialToken={authStore.token()}
          submitLabel="Save & reconnect"
          onCancel={props.onClose}
        />
        <button
          type="button"
          onClick={handleSignOut}
          class="min-h-[44px] rounded-lg border border-border-default bg-transparent text-sm font-medium text-error hover:bg-error/10"
        >
          Sign out / change host
        </button>
      </div>
    </div>
  );
}
