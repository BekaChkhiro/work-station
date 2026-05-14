// In-app QR scanner. Opens a sheet with the rear camera feed, decodes
// frames with the native `BarcodeDetector` API when available (Chrome
// Android, Edge), and falls back to `jsQR` running on a hidden canvas
// (iOS Safari, older browsers).
//
// On a successful decode we hand the raw payload to `parsePairingPayload`
// — anything that yields a host + token closes the sheet and pairs.
//
// Camera access requires a secure context (HTTPS or localhost). The
// Vercel-hosted PWA satisfies that; in the dev server we surface a
// helpful message.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import jsQR from "jsqr";
import { parsePairingPayload, type PairingPayload } from "../lib/pairing";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorCtor = new (init?: { formats?: string[] }) => BarcodeDetectorLike;

interface ScanQrSheetProps {
  onClose: () => void;
  onResult: (payload: PairingPayload) => void;
}

export function ScanQrSheet(props: ScanQrSheetProps) {
  const [error, setError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(true);

  let videoRef: HTMLVideoElement | undefined;
  let canvasRef: HTMLCanvasElement | undefined;
  let stream: MediaStream | null = null;
  let rafHandle: number | null = null;
  let detector: BarcodeDetectorLike | null = null;
  let stopped = false;

  function deliver(raw: string) {
    if (stopped) return;
    const parsed = parsePairingPayload(raw);
    if (!parsed) return;
    stopped = true;
    props.onResult(parsed);
  }

  async function decodeOnce() {
    if (stopped || !videoRef || !canvasRef) return;
    const video = videoRef;
    if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
      rafHandle = requestAnimationFrame(() => void decodeOnce());
      return;
    }

    if (detector) {
      try {
        const codes = await detector.detect(video);
        if (codes[0]?.rawValue) {
          deliver(codes[0].rawValue);
          return;
        }
      } catch {
        // Detector flaked — fall back to jsQR on the next tick.
        detector = null;
      }
    } else {
      const canvas = canvasRef;
      const w = (canvas.width = video.videoWidth);
      const h = (canvas.height = video.videoHeight);
      if (w > 0 && h > 0) {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const image = ctx.getImageData(0, 0, w, h);
          const code = jsQR(image.data, w, h, { inversionAttempts: "attemptBoth" });
          if (code?.data) {
            deliver(code.data);
            return;
          }
        }
      }
    }

    if (!stopped) rafHandle = requestAnimationFrame(() => void decodeOnce());
  }

  async function start() {
    setError(null);
    setStarting(true);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser doesn't expose a camera API. Paste the host + token instead.");
      setStarting(false);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera access denied. Allow it in your browser settings or paste credentials manually.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera found on this device.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't open the camera.");
      }
      setStarting(false);
      return;
    }

    if (videoRef) {
      videoRef.srcObject = stream;
      try {
        await videoRef.play();
      } catch {
        // Some browsers reject autoplay even with muted — surface a tap-to-start.
      }
    }
    const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (ctor) {
      try {
        detector = new ctor({ formats: ["qr_code"] });
      } catch {
        detector = null;
      }
    }
    setStarting(false);
    void decodeOnce();
  }

  function stop() {
    stopped = true;
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (videoRef) {
      videoRef.srcObject = null;
    }
  }

  onMount(() => {
    void start();
  });
  onCleanup(stop);

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) props.onClose();
  }

  return (
    <div
      class="fixed inset-0 z-[70] flex items-end justify-center bg-black/85 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Scan pairing QR code"
      onClick={handleBackdrop}
    >
      <div
        class="flex w-full max-w-md flex-col gap-3 rounded-t-2xl border-t border-border-default bg-canvas px-4 pt-4 pb-6 shadow-2xl sm:rounded-2xl sm:border"
        style={{ "padding-bottom": "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex flex-col">
            <h2 class="text-base font-semibold tracking-tight">Scan pairing QR</h2>
            <p class="text-xs text-fg-tertiary">Open Work Station → Settings → Mobile pairing.</p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            class="min-h-[40px] min-w-[40px] rounded-lg text-fg-secondary hover:bg-hover"
            aria-label="Close scanner"
          >
            ✕
          </button>
        </div>
        <div class="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} class="h-full w-full object-cover" playsinline muted autoplay />
          <canvas ref={canvasRef} class="hidden" aria-hidden="true" />
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div class="h-[70%] w-[70%] rounded-2xl border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
          <Show when={starting()}>
            <div class="absolute inset-0 flex items-center justify-center text-xs text-white/80">
              Starting camera…
            </div>
          </Show>
        </div>
        <Show when={error()}>
          <p class="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {error()}
          </p>
        </Show>
      </div>
    </div>
  );
}
