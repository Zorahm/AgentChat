/** Completion chime — a short synthesized sound on model-reply / install finish.
 *
 * Web Audio only (no bundled asset), so it works in the Tauri WebView too. The
 * enabled flag is mirrored from persisted settings via setNotifySoundEnabled so
 * deep components can call playNotificationSound() without prop-drilling it.
 */

let enabled = false;
let ctx: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

/** Sync the module flag with the persisted `notify_sound` setting. */
export function setNotifySoundEnabled(value: boolean): void {
  enabled = value;
}

function getAudioContext(): AudioContext | null {
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

function playTone(audio: AudioContext, freq: number, start: number, dur: number): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Quick attack, exponential decay — a soft "ding".
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/**
 * Play the completion chime, but only when enabled AND the window is not the
 * user's current focus (minimized, another app on top, or a background tab) —
 * no point beeping at someone already watching the reply land.
 */
export function playNotificationSound(): void {
  if (!enabled) return;
  if (!document.hidden && document.hasFocus()) return;
  try {
    const audio = getAudioContext();
    if (!audio) return;
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    // Two-note rising chime.
    playTone(audio, 880, now, 0.16);
    playTone(audio, 1320, now + 0.15, 0.24);
  } catch {
    /* audio unavailable (policy / no device) — stay silent */
  }
}
