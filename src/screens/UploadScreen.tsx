import { Show, createSignal } from "solid-js";
import { getFrameCount, probeVideo, type ProbeResultT } from "../lib/video";

type PropsT = {
  onStart: (file: File, probe: ProbeResultT) => void;
};

const ACCEPT =
  "video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi,.wmv,.flv,.ts,.mts,.m2ts,.3gp";

const formatDuration = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

export const UploadScreen = (props: PropsT) => {
  const [phase, setPhase] = createSignal<"idle" | "probing" | "ready">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);
  const [probe, setProbe] = createSignal<ProbeResultT | null>(null);
  let fileRef: File | null = null;
  let inputRef: HTMLInputElement | undefined;

  const acceptFile = async (file: File | undefined) => {
    if (!file || phase() === "probing") return;
    probe()?.demuxer.destroy();
    setProbe(null);
    setError(null);
    setPhase("probing");
    fileRef = file;
    try {
      const result = await probeVideo(file);
      setProbe(result);
      setPhase("ready");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not read this file as a video.",
      );
      setPhase("idle");
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    void acceptFile(event.dataTransfer?.files?.[0]);
  };

  const start = () => {
    const result = probe();
    if (!result || !fileRef) return;
    props.onStart(fileRef, result);
  };

  return (
    <main
      class="splash-shell"
      classList={{ "is-dragging": isDragging() }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
    >
      <div class="splash-noise" aria-hidden="true"></div>

      <section class="splash-layout">
        <div class="splash-copy">
          <z-stack gap="md">
            <z-badge tone="primary" label="frame extraction"></z-badge>
            <z-display size="md" tag="h1">
              fraame
            </z-display>
            <z-text class="splash-subcopy">
              Scrub through your videos and save the exact frames you need. No
              watermarks or limits.
            </z-text>

            <z-text color="muted" size="sm">
              Drop a video file anywhere on this page or click the button below
              to select one to upload.
            </z-text>

            <div class="splash-actions">
              <z-button tone="primary" on:click={() => inputRef?.click()}>
                {phase() === "ready" ? "change video" : "choose video"}
              </z-button>
            </div>
          </z-stack>
        </div>

        <div class="splash-controls">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            style="display: none"
            onChange={(event) => {
              void acceptFile(event.currentTarget.files?.[0] ?? undefined);
              event.currentTarget.value = "";
            }}
          />

          <Show when={phase() === "probing"}>
            <z-surface border radius="14px" full-width>
              <z-stack gap="2xs" inset="md">
                <z-progress is-indeterminate tone="primary"></z-progress>
                <z-text size="sm" color="muted">
                  Reading video...
                </z-text>
              </z-stack>
            </z-surface>
          </Show>

          <Show when={error()}>
            <z-alert tone="danger" heading="Could not read that video">
              {error()}
            </z-alert>
          </Show>

          <Show when={phase() === "ready" && probe()}>
            {(result) => (
              <div class="clip-options">
                <div class="clip-info">
                  <strong>{result().info.fileName}</strong>
                  <span>
                    {result().info.width}x{result().info.height} -{" "}
                    {result().info.fps.toFixed(2)} fps -{" "}
                    {formatDuration(result().info.durationSec)}
                  </span>
                </div>

                <div class="extract-summary">
                  <span>
                    {getFrameCount(result().info).toLocaleString()} frames
                  </span>
                </div>

                <z-button tone="primary" on:click={start}>
                  open
                </z-button>
              </div>
            )}
          </Show>
        </div>
      </section>
    </main>
  );
};
