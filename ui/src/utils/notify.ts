/** Completion chime — a short notification on model-reply / install finish.
 *
 * Two sources: a synthesized Web Audio "ding" (the default, no bundled asset so
 * it works in the Tauri WebView too) and an optional user-supplied sound stored
 * as a data URL. Both the enabled flag and the custom source are mirrored from
 * persisted settings (setNotifySoundEnabled / setNotifySound) so deep components
 * can call playNotificationSound() without prop-drilling them.
 */

let enabled = false;
let ctx: AudioContext | null = null;

/** Custom sound as a data URL (e.g. "data:audio/mpeg;base64,..."), or null for the chime. */
let customSrc: string | null = null;
let customAudio: HTMLAudioElement | null = null;

type AudioContextCtor = typeof AudioContext;

/** Sync the module flag with the persisted `notify_sound` setting. */
export function setNotifySoundEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Sync the persisted `notify_sound_data` setting. Pass null/empty to clear the
 * custom sound and fall back to the synthesized chime. The <audio> element is
 * rebuilt lazily on the next play so we don't decode until needed.
 */
export function setNotifySound(src: string | null): void {
  const next = src && src.length > 0 ? src : null;
  if (next === customSrc) return;
  customSrc = next;
  customAudio = null;
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

/** The built-in two-note rising chime (fallback when no custom sound is set). */
function playChime(): void {
  try {
    const audio = getAudioContext();
    if (!audio) return;
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    playTone(audio, 880, now, 0.16);
    playTone(audio, 1320, now + 0.15, 0.24);
  } catch {
    /* audio unavailable (policy / no device) — stay silent */
  }
}

/** Play the user's custom sound. Returns false if none is set or playback fails. */
function playCustom(): boolean {
  if (!customSrc) return false;
  try {
    if (!customAudio) customAudio = new Audio(customSrc);
    customAudio.currentTime = 0;
    void customAudio.play();
    return true;
  } catch {
    return false;
  }
}

/**
 * Play the completion notification, but only when enabled AND the window is not
 * the user's current focus (minimized, another app on top, or a background tab)
 * — no point beeping at someone already watching the reply land. Uses the custom
 * sound when set, otherwise the synthesized chime.
 */
export function playNotificationSound(): void {
  if (!enabled) return;
  if (!document.hidden && document.hasFocus()) return;
  if (playCustom()) return;
  playChime();
}

/**
 * Play the current sound right now, ignoring the enabled flag and focus guard.
 * For the "preview" button in settings so the user can hear their pick.
 */
export function previewNotificationSound(): void {
  if (playCustom()) return;
  playChime();
}
