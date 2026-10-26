import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { withStorageDom } from "./dom-test-environment.mjs";
import { withModules } from "./test-server.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await withModules(async (load) => {
  const { useIdleReturn, useWallDisplay, useScreenWakeLock } = await load(
    "/packages/engine/src/navigation/wall-display.ts",
  );
  const { CabaneDomProvider } = await load("/packages/engine/src/CabaneDom.tsx");

  function IdleHarness({ enabled, onIdle }) {
    useIdleReturn({ enabled, timeoutMs: 60_000, onIdle });
    return null;
  }

  test("a wall display returns once after a minute without input, and input restarts the wait", async (context) => {
    await withStorageDom(async ({ window, document }) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      let idle = 0;
      await act(async () =>
        root.render(createElement(IdleHarness, { enabled: true, onIdle: () => idle++ })),
      );
      context.mock.timers.tick(59_999);
      assert.equal(idle, 0);
      context.mock.timers.tick(1);
      assert.equal(idle, 1);
      context.mock.timers.tick(120_000);
      assert.equal(idle, 1, "staying idle does not repeat the return");

      window.dispatchEvent(new window.Event("pointerdown"));
      context.mock.timers.tick(30_000);
      window.dispatchEvent(new window.Event("keydown"));
      context.mock.timers.tick(59_999);
      assert.equal(idle, 1, "each input restarts the minute");
      context.mock.timers.tick(1);
      assert.equal(idle, 2);
      await act(async () => root.unmount());
    });
  });

  test("input inside the Home Assistant panel's shadow root also restarts the wait", async (context) => {
    await withStorageDom(async ({ window, document }) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const host = document.body.appendChild(document.createElement("div"));
      const shadow = host.attachShadow({ mode: "open" });
      const container = shadow.appendChild(document.createElement("div"));
      const environment = {
        root: shadow,
        container,
        portalContainer: container,
        eventTarget: shadow,
      };
      const root = createRoot(container);
      let idle = 0;
      await act(async () =>
        root.render(
          createElement(
            CabaneDomProvider,
            { environment },
            createElement(IdleHarness, { enabled: true, onIdle: () => idle++ }),
          ),
        ),
      );
      context.mock.timers.tick(50_000);
      shadow.dispatchEvent(new window.Event("pointerdown"));
      context.mock.timers.tick(50_000);
      assert.equal(idle, 0);
      context.mock.timers.tick(10_000);
      assert.equal(idle, 1);
      await act(async () => root.unmount());
    });
  });

  test("the first input after an idle return wakes the display once", async (context) => {
    await withStorageDom(async ({ window, document }) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      let active = 0;
      function Harness() {
        useIdleReturn({ enabled: true, timeoutMs: 60_000, onIdle() {}, onActive: () => active++ });
        return null;
      }
      await act(async () => root.render(createElement(Harness)));
      window.dispatchEvent(new window.Event("pointerdown"));
      assert.equal(active, 0, "input while already active is not a wake-up");
      context.mock.timers.tick(60_000);
      window.dispatchEvent(new window.Event("pointerdown"));
      window.dispatchEvent(new window.Event("pointermove"));
      assert.equal(active, 1);
      await act(async () => root.unmount());
    });
  });

  test("a disabled wall display never returns on its own", async (context) => {
    await withStorageDom(async ({ document }) => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      let idle = 0;
      await act(async () =>
        root.render(createElement(IdleHarness, { enabled: false, onIdle: () => idle++ })),
      );
      context.mock.timers.tick(600_000);
      assert.equal(idle, 0);
      await act(async () => root.unmount());
    });
  });

  test("the wall display choice is remembered per home on this device only", async () => {
    await withStorageDom(async ({ window, document }) => {
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      const seen = {};
      function Harness({ home }) {
        const [enabled, setEnabled] = useWallDisplay(home);
        seen[home] = { enabled, setEnabled };
        return null;
      }
      const render = () =>
        act(async () =>
          root.render([
            createElement(Harness, { key: "a", home: "home-a" }),
            createElement(Harness, { key: "b", home: "home-b" }),
          ]),
        );
      await render();
      assert.equal(seen["home-a"].enabled, false);
      await act(async () => seen["home-a"].setEnabled(true));
      assert.equal(seen["home-a"].enabled, true);
      assert.equal(seen["home-b"].enabled, false);
      assert.equal(
        window.localStorage.getItem('cabane.wall-display.v1:"home-a"'),
        JSON.stringify({ version: 1, enabled: true }),
      );
      await act(async () => seen["home-a"].setEnabled(false));
      assert.equal(seen["home-a"].enabled, false);
      await act(async () => root.unmount());
    });
  });

  test("an unreadable wall display preference leaves the display off", async () => {
    await withStorageDom(async ({ window, document }) => {
      window.localStorage.setItem('cabane.wall-display.v1:"home-c"', "{not json");
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      let enabled;
      function Harness() {
        [enabled] = useWallDisplay("home-c");
        return null;
      }
      await act(async () => root.render(createElement(Harness)));
      assert.equal(enabled, false);
      await act(async () => root.unmount());
    });
  });

  test("a wall display keeps the screen awake, renews the lock when shown again and releases it when turned off", async () => {
    await withStorageDom(async ({ window, document }) => {
      const requests = [];
      const sentinels = [];
      Object.defineProperty(window.navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async (type) => {
            requests.push(type);
            const sentinel = { released: false, release: async () => (sentinel.released = true) };
            sentinels.push(sentinel);
            return sentinel;
          },
        },
      });
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      function Harness({ enabled }) {
        useScreenWakeLock(enabled);
        return null;
      }
      await act(async () => root.render(createElement(Harness, { enabled: true })));
      assert.deepEqual(requests, ["screen"]);

      // The browser drops the lock while the page is hidden.
      sentinels[0].released = true;
      visibility = "hidden";
      await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
      assert.equal(requests.length, 1);
      visibility = "visible";
      await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
      assert.deepEqual(requests, ["screen", "screen"]);

      await act(async () => root.render(createElement(Harness, { enabled: false })));
      assert.equal(sentinels[1].released, true);
      await act(async () => root.unmount());
    });
  });

  test("a browser without screen wake lock still runs the wall display", async () => {
    await withStorageDom(async ({ document }) => {
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      function Harness() {
        useScreenWakeLock(true);
        return null;
      }
      await act(async () => root.render(createElement(Harness)));
      await act(async () => root.unmount());
    });
  });
});
