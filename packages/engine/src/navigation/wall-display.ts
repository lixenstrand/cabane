import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { useCabaneDom } from "../CabaneDom";

const INPUT_EVENTS = ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const;

/**
 * Calls `onIdle` once after `timeoutMs` without input; any input restarts the
 * wait, and the first input after an idle return calls `onActive`.
 */
export function useIdleReturn({
  enabled,
  timeoutMs,
  onIdle,
  onActive,
}: {
  enabled: boolean;
  timeoutMs: number;
  onIdle: () => void;
  onActive?: (() => void) | undefined;
}) {
  const idle = useEffectEvent(onIdle);
  const active = useEffectEvent(() => onActive?.());
  const { events } = useCabaneDom();
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idled = false;
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idled = true;
        idle();
      }, timeoutMs);
    };
    const input = () => {
      if (idled) {
        idled = false;
        active();
      }
      wait();
    };
    wait();
    INPUT_EVENTS.forEach((name) => events.addEventListener(name, input, { passive: true }));
    return () => {
      clearTimeout(timer);
      INPUT_EVENTS.forEach((name) => events.removeEventListener(name, input));
    };
  }, [enabled, timeoutMs, events]);
}

// Device-local like Lock view: outside project exports and HA sync, so only the
// wall screen itself becomes a wall display.
const wallDisplayKey = (home: string) => `cabane.wall-display.v1:${JSON.stringify(home)}`;
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();

function readWallDisplay(key: string) {
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  let enabled = false;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
      version?: unknown;
      enabled?: unknown;
    } | null;
    enabled = value?.version === 1 && value.enabled === true;
  } catch {
    /* Private/blocked storage or malformed data leaves the display off. */
  }
  memory.set(key, enabled);
  return enabled;
}

function writeWallDisplay(key: string, enabled: boolean) {
  memory.set(key, enabled);
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, enabled }));
  } catch {
    /* Keep the choice in memory for this visit. */
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useWallDisplay(home: string) {
  const key = wallDisplayKey(home);
  const enabled = useSyncExternalStore(
    subscribe,
    () => readWallDisplay(key),
    () => false,
  );
  return [enabled, (value: boolean) => writeWallDisplay(key, value)] as const;
}

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<unknown>;
}

/** Keeps the screen on while enabled; browsers drop the lock when the page hides. */
export function useScreenWakeLock(enabled: boolean) {
  useEffect(() => {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    if (!enabled || !wakeLock) return;
    let active = true;
    let sentinel: WakeLockSentinelLike | null = null;
    const acquire = () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      wakeLock
        .request("screen")
        .then((next) => {
          if (active) sentinel = next;
          else void next.release();
        })
        .catch(() => {
          /* Denied (battery saver, policy): the display still works, it may sleep. */
        });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release();
    };
  }, [enabled]);
}

/**
 * Dashboard wiring: after half a minute untouched a wall display closes panels,
 * returns home and turns slowly (`ambient`) until someone touches the screen.
 */
export function useDashboardWallDisplay({
  home,
  paused,
  returnHome,
}: {
  home: string;
  /** Walk, setup and mapping keep their own state while a person uses them. */
  paused: boolean;
  returnHome: () => void;
}) {
  const [enabled, setEnabled] = useWallDisplay(home);
  const [idle, setIdle] = useState(false);
  useIdleReturn({
    enabled: enabled && !paused,
    timeoutMs: 30_000,
    onIdle: () => {
      returnHome();
      setIdle(true);
    },
    onActive: () => setIdle(false),
  });
  useScreenWakeLock(enabled);
  return {
    ambient: enabled && idle && !paused,
    menu: { enabled, onToggle: () => setEnabled(!enabled) },
  };
}
