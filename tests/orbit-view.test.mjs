import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { withStorageDom } from "./dom-test-environment.mjs";
import { create } from "@react-three/test-renderer";
import { withModules } from "./test-server.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await withModules(async (load) => {
  const { OrbitNavigation } = await load("/packages/engine/src/OrbitNavigation.tsx");
  const { OrbitViewMenu } = await load("/packages/engine/src/action-bar/OrbitViewMenu.tsx");
  const { OrbitCamera } = await load("/packages/engine/src/OrbitCamera.tsx");
  const { orbitViewKey, readOrbitView, writeOrbitView, fitSavedOrbitView, useDashboardOrbitView } =
    await load("/packages/engine/src/navigation/orbit-view.ts");
  const { neutralDemoManifest } = await load("/packages/engine/src/demo.ts");
  const floor = neutralDemoManifest.floors[0];
  const room = floor.rooms[0];
  const options = {
    width: 1200,
    height: 900,
    beforeReturn(canvas) {
      canvas.ownerDocument = { addEventListener() {}, removeEventListener() {} };
    },
  };
  const controlsFor = (renderer) =>
    renderer.scene.find(
      (node) => node.instance?.target && node.instance?.object?.isOrthographicCamera,
    ).instance;
  const pose = (controls) => [
    ...controls.object.position.toArray(),
    ...controls.target.toArray(),
    controls.object.zoom,
  ];
  const close = (actual, expected) =>
    actual.forEach((n, i) =>
      assert.ok(Math.abs(n - expected[i]) < 0.001, `${n} vs ${expected[i]}`),
    );
  const frame = { left: 22, top: 156, width: 720, height: 620 };

  test("manual views survive remounts, isolate homes/floors, and ignore temporary room animations", async () => {
    const viewKey = orbitViewKey("manual-home", floor.id);
    const props = { floor, viewKey, resetKey: 0, roomFrame: frame, reducedMotion: true };
    let renderer = await create(createElement(OrbitCamera, props), options);
    let expected;
    try {
      const controls = controlsFor(renderer);
      controls.dispatchEvent({ type: "start" });
      controls.target.x += 2;
      controls.object.position.x += 2;
      controls.object.zoom = 30;
      controls.update();
      expected = pose(controls);
      await renderer.update(createElement(OrbitCamera, { ...props, room }));
      assert.notDeepEqual(pose(controls), expected);
      await renderer.update(createElement(OrbitCamera, props));
      close(pose(controls), expected);
      // Unmount while focused, as when entering Walk or the editor.
      await renderer.update(createElement(OrbitCamera, { ...props, room }));
    } finally {
      await renderer.unmount();
    }
    renderer = await create(createElement(OrbitCamera, { ...props, room }), options);
    try {
      close(pose(controlsFor(renderer)), expected);
      await renderer.update(
        createElement(OrbitCamera, { ...props, viewKey: orbitViewKey("other-home", floor.id) }),
      );
      assert.notDeepEqual(pose(controlsFor(renderer)), expected);
      await renderer.update(
        createElement(OrbitCamera, {
          ...props,
          viewKey: orbitViewKey("manual-home", "other-floor"),
        }),
      );
      assert.notDeepEqual(pose(controlsFor(renderer)), expected);
      await renderer.update(createElement(OrbitCamera, props));
      close(pose(controlsFor(renderer)), expected);
    } finally {
      await renderer.unmount();
    }
  });

  test("top-down persists; lock prevents room reframing; explicit reset restores the default", async () => {
    const viewKey = orbitViewKey("locked-home", floor.id);
    const viewActions = { current: null };
    const props = {
      floor,
      viewKey,
      viewActions,
      resetKey: 0,
      roomFrame: frame,
      reducedMotion: true,
    };
    let renderer = await create(createElement(OrbitCamera, props), options);
    let overhead;
    try {
      const controls = controlsFor(renderer);
      const baseline = pose(controls);
      await act(async () => viewActions.current.topDown());
      assert.ok(controls.getPolarAngle() < 0.001);
      overhead = pose(controls);
      writeOrbitView(viewKey, { locked: true });
      await renderer.update(createElement(OrbitCamera, { ...props, locked: true, room }));
      assert.equal(controls.enabled, false);
      close(pose(controls), overhead);
      await renderer.update(
        createElement(OrbitCamera, { ...props, locked: true, room, roomRequestKey: 1 }),
      );
      close(pose(controls), overhead);
      await act(async () => viewActions.current.reset());
      close(pose(controls), baseline);
      assert.equal(controls.enabled, false);
      await act(async () => viewActions.current.topDown());
    } finally {
      await renderer.unmount();
    }
    assert.equal(readOrbitView(viewKey).locked, true);
    renderer = await create(createElement(OrbitCamera, { ...props, locked: true, room }), options);
    try {
      close(pose(controlsFor(renderer)), overhead);
    } finally {
      await renderer.unmount();
    }
  });

  test("an idle wall display returns to the remembered view and slowly turns around it", async () => {
    const viewKey = orbitViewKey("wall-home", floor.id);
    const props = { floor, viewKey, resetKey: 0, roomFrame: frame, reducedMotion: true };
    const renderer = await create(createElement(OrbitCamera, props), options);
    try {
      const controls = controlsFor(renderer);
      controls.dispatchEvent({ type: "start" });
      controls.target.x += 2;
      controls.object.position.x += 2;
      controls.update();
      const remembered = pose(controls);
      await renderer.update(createElement(OrbitCamera, { ...props, room }));
      assert.notDeepEqual(pose(controls), remembered);

      await renderer.update(
        createElement(OrbitCamera, { ...props, reducedMotion: false, ambient: true }),
      );
      close(pose(controls), remembered);
      assert.equal(controls.autoRotate, true);
      assert.ok(controls.autoRotateSpeed > 0 && controls.autoRotateSpeed <= 0.5, "slow turn");

      await renderer.update(createElement(OrbitCamera, { ...props, reducedMotion: false }));
      assert.equal(controls.autoRotate, false, "input ends the turn");
      await renderer.update(createElement(OrbitCamera, { ...props, ambient: true }));
      assert.equal(controls.autoRotate, false, "reduced motion keeps the display still");
      assert.deepEqual(readOrbitView(viewKey).pose.target, remembered.slice(3, 6));
    } finally {
      await renderer.unmount();
    }
  });

  test("a locked wall display returns to its locked view when someone touches it", async () => {
    const viewKey = orbitViewKey("locked-wall-home", floor.id);
    const props = { floor, viewKey, resetKey: 0, roomFrame: frame, locked: true };
    const renderer = await create(createElement(OrbitCamera, props), options);
    try {
      const controls = controlsFor(renderer);
      const locked = pose(controls);
      await renderer.update(createElement(OrbitCamera, { ...props, ambient: true }));
      // Stand in for the slow turn having moved the camera.
      controls.object.position.x += 3;
      controls.update();
      assert.notDeepEqual(pose(controls), locked);
      await renderer.update(createElement(OrbitCamera, props));
      close(pose(controls), locked);
    } finally {
      await renderer.unmount();
    }
  });

  test("the View menu offers a Wall display toggle that reports its state", async () => {
    await withStorageDom(async ({ document }) => {
      const root = createRoot(document.body);
      const calls = [];
      const props = {
        locked: false,
        wallDisplay: { enabled: true, onToggle: () => calls.push("wall") },
        disabled: false,
        onTopDown: undefined,
        onResetView: undefined,
        onToggleLock: undefined,
        onClose: () => calls.push("close"),
      };
      try {
        await act(async () => root.render(createElement(OrbitViewMenu, props)));
        const toggle = document.querySelector('[aria-label="Wall display"]');
        assert.equal(toggle.getAttribute("aria-pressed"), "true");
        await act(async () => toggle.click());
        assert.deepEqual(calls, ["wall", "close"]);
        await act(async () =>
          root.render(
            createElement(OrbitViewMenu, {
              ...props,
              wallDisplay: { ...props.wallDisplay, enabled: false },
            }),
          ),
        );
        assert.equal(
          document.querySelector('[aria-label="Wall display"]').getAttribute("aria-pressed"),
          "false",
        );
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  test("View actions are accessible, camera buttons honor lock, and Walk disables view actions", async () => {
    await withStorageDom(async ({ document }) => {
      const root = createRoot(document.body);
      const calls = [];
      const props = {
        locked: true,
        disabled: false,
        onTopDown: () => calls.push("top"),
        onResetView: () => calls.push("reset"),
        onToggleLock: () => calls.push("lock"),
        onClose() {},
      };
      try {
        await act(async () => root.render(createElement(OrbitViewMenu, props)));
        assert.equal(
          document.querySelector('[aria-label="Lock view"]').getAttribute("aria-pressed"),
          "true",
        );
        for (const button of document.querySelectorAll("button"))
          await act(async () => button.click());
        assert.deepEqual(calls, ["top", "reset", "lock"]);
        await act(async () =>
          root.render(createElement(OrbitViewMenu, { ...props, disabled: true })),
        );
        assert.ok([...document.querySelectorAll("button")].every((button) => button.disabled));
        await act(async () =>
          root.render(createElement(OrbitNavigation, { controls: null, locked: true })),
        );
        assert.ok([...document.querySelectorAll("button")].every((button) => button.disabled));
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  test("restored views adapt to viewport size and outdated camera distances fall back", async () => {
    const viewKey = orbitViewKey("resize", floor.id);
    const saved = { position: [10, 20, 10], target: [0, 0.2, 0], zoom: 60, viewport: [1200, 900] };
    writeOrbitView(viewKey, { pose: saved });
    const renderer = await create(createElement(OrbitCamera, { floor, resetKey: 0, viewKey }), {
      ...options,
      width: 600,
    });
    try {
      assert.equal(controlsFor(renderer).object.zoom, 30);
    } finally {
      await renderer.unmount();
    }
    const outdatedKey = orbitViewKey("outdated", floor.id);
    writeOrbitView(outdatedKey, { pose: { ...saved, position: [50000, 50000, 50000] } });
    const fallback = await create(
      createElement(OrbitCamera, { floor, resetKey: 0, viewKey: outdatedKey }),
      options,
    );
    try {
      assert.ok(controlsFor(fallback).object.position.length() < 100);
    } finally {
      await fallback.unmount();
    }
  });

  test("repeated viewport changes preserve the manual pose without accumulating zoom drift", async () => {
    let state;
    const viewKey = orbitViewKey("resize-cycle", floor.id);
    const props = { floor, resetKey: 0, viewKey };
    const renderer = await create(createElement(OrbitCamera, props), {
      ...options,
      onCreated(value) {
        state = value;
      },
    });
    try {
      const controls = controlsFor(renderer);
      controls.dispatchEvent({ type: "start" });
      controls.object.zoom = 60;
      controls.update();
      const before = pose(controls);
      await act(async () => state.setSize(600, 900));
      assert.equal(controls.object.zoom, 30);
      await act(async () => state.setSize(1200, 900));
      close(pose(controls), before);
      assert.equal(readOrbitView(viewKey).pose.zoom, 60);
      assert.deepEqual(readOrbitView(viewKey).pose.viewport, [1200, 900]);
    } finally {
      await renderer.unmount();
    }
  });

  test("dashboard bindings follow replacement controls and persist lock per floor", async () => {
    let binding;
    function DashboardCamera({ floorId }) {
      const view = useDashboardOrbitView("binding-home", floorId);
      useEffect(() => {
        binding = view;
      });
      return createElement(OrbitCamera, { floor, resetKey: 0, ...view.cameraProps });
    }
    const renderer = await create(createElement(DashboardCamera, { floorId: "a" }), options);
    try {
      const original = binding.controls;
      assert.equal(original, controlsFor(renderer));
      await act(async () => binding.menuProps.onTopDown());
      assert.ok(binding.controls.getPolarAngle() < 0.001, "top action applies");
      assert.ok(readOrbitView(orbitViewKey("binding-home", "a")).pose, "top action saves");
      await act(async () => binding.menuProps.onToggleViewLock());
      assert.equal(binding.locked, true);
      assert.equal(binding.controls.enabled, false);
      assert.ok(binding.controls.getPolarAngle() < 0.001, "lock keeps top view");
      await renderer.update(createElement(DashboardCamera, { floorId: "b" }));
      assert.notEqual(binding.controls, original);
      assert.equal(binding.controls, controlsFor(renderer));
      assert.equal(binding.locked, false);
      await renderer.update(createElement(DashboardCamera, { floorId: "a" }));
      assert.equal(binding.locked, true);
      await act(async () => renderer.advanceFrames(1, 1 / 60));
      assert.ok(
        binding.controls.getPolarAngle() < 0.001,
        "restored controls settle overhead on the first frame",
      );
    } finally {
      await renderer.unmount();
    }
  });

  test("storage validation, viewport adaptation and blocked-storage recovery", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map();
    let blocked = false;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem(key) {
          if (blocked) throw new Error("blocked");
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          if (blocked) throw new Error("full");
          values.set(key, value);
        },
      },
    });
    try {
      const saved = { position: [10, 20, 10], target: [0, 0, 0], zoom: 60, viewport: [1200, 900] };
      const valid = orbitViewKey("stored", "floor");
      values.set(valid, JSON.stringify({ version: 1, locked: true, pose: saved }));
      assert.deepEqual(readOrbitView(valid).pose, saved);
      assert.equal(fitSavedOrbitView(saved, 600, 900).zoom, 30);
      for (const [name, value] of Object.entries({
        json: "broken",
        version: JSON.stringify({ version: 2, locked: true, pose: saved }),
        vector: JSON.stringify({ version: 1, locked: true, pose: { ...saved, position: [1] } }),
        zoom: JSON.stringify({ version: 1, locked: false, pose: { ...saved, zoom: -1 } }),
        viewport: JSON.stringify({
          version: 1,
          locked: false,
          pose: { ...saved, viewport: [0, 900] },
        }),
      })) {
        const key = orbitViewKey("invalid", name);
        values.set(key, value);
        assert.equal(readOrbitView(key).pose, null);
      }
      blocked = true;
      const key = orbitViewKey("blocked", "floor");
      assert.equal(readOrbitView(key).pose, null);
      writeOrbitView(key, { pose: saved, locked: true });
      assert.deepEqual(readOrbitView(key).pose, saved);
      blocked = false;
      writeOrbitView(key, { locked: false });
      assert.deepEqual(JSON.parse(values.get(key)).pose, saved);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete globalThis.localStorage;
    }
  });
});
