import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "@react-three/test-renderer";
import { JSDOM } from "jsdom";
import { withModules } from "./test-server.mjs";
import { withStorageDom } from "./dom-test-environment.mjs";
import { lightGroupFixture } from "./fixtures/light-group.mjs";

await withModules(async (load) => {
  const { neutralDemoManifest } = await load("/packages/engine/src/demo.ts");
  const profileApi = await load("/packages/engine/src/runtime-binding-profile.ts");
  const { resolveHomeAssistantBindings } = await load(
    "/packages/engine/src/home-assistant-resolver.ts",
  );
  const { DeviceMappingInspector } = await load(
    "/packages/engine/src/home-assistant-mapping/DeviceMappingInspector.tsx",
  );
  const { groupRoomMappingRelationships } = await load(
    "/packages/engine/src/home-assistant-mapping/device-mapping-groups.ts",
  );
  const { RoomControlSheet } = await load(
    "/packages/engine/src/home-assistant-dashboard/RoomControlSheet.tsx",
  );
  const { deriveRoomStatusMap } = await load("/packages/engine/src/room-status/model.ts");
  const { HomeAssistantSceneLighting } = await load(
    "/packages/engine/src/HomeAssistantSceneLighting.tsx",
  );
  const { stableDeviceRegistry } = await load("/packages/catalog/src/device/index.ts");

  test("Light Group helpers without a device or area are selectable, shareable and portable", () => {
    const { manifest, room, profile, runtime } = lightGroupFixture(neutralDemoManifest);
    const relationship = groupRoomMappingRelationships(manifest, room.id)[0].relationships[0];
    const html = renderToStaticMarkup(
      React.createElement(DeviceMappingInspector, {
        manifest,
        room,
        profile,
        runtime,
        relationship,
        state: "open",
        disabled: false,
        inline: true,
        onEntityIdsBySlotIdChange() {},
        onSelectionMade() {},
        onCollapse() {},
        onReopen() {},
      }),
    );
    const document = new JSDOM(html).window.document;
    const choice = document.querySelector('input[value="light.kitchen_pendants"]');
    assert.ok(choice);
    assert.equal(choice.disabled, false);
    assert.equal(choice.checked, true);
    assert.match(choice.closest("details").textContent, /No area/);
    assert.equal(choice.closest("details").open, true);
    assert.match(choice.closest("label").textContent, /Kitchen pendants.*already used/);
    assert.equal(
      profileApi.importRuntimeBindingProfile(
        profileApi.exportRuntimeBindingProfile(profile),
        manifest,
        runtime,
      ).valid,
      true,
    );
    const automatic = profileApi.automaticallyMapRuntimeBindings(
      manifest,
      { ...profile, entityIdsBySlotId: {} },
      runtime,
    );
    assert.equal(
      Object.values(automatic.profile.entityIdsBySlotId).includes("light.kitchen_pendants"),
      false,
    );
    for (const device of room.devices) {
      const resolved = resolveHomeAssistantBindings(manifest, profile, runtime).rooms[room.id];
      assert.deepEqual(resolved.devices.find((entry) => entry.slot.id === device.id).issues, []);
    }
  });

  test("one room control targets the HA group while every pendant remains focusable and guarded", async () => {
    const { manifest, room, profile, runtime } = lightGroupFixture(neutralDemoManifest);
    await withStorageDom(async ({ document }) => {
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      const calls = [];
      const render = async (selectedDeviceId = null) => {
        const resolved = resolveHomeAssistantBindings(manifest, profile, runtime);
        await act(async () =>
          root.render(
            React.createElement(RoomControlSheet, {
              resolved: resolved.rooms[room.id],
              roomStatus: deriveRoomStatusMap(manifest, profile, resolved, runtime)[room.id],
              status: runtime.status,
              canMutate: runtime.canMutate,
              selectedDeviceId,
              onSelectDevice() {},
              onHome() {},
              onWalk() {},
              onConnectDevices() {},
              onReconnect() {},
              onRetry() {},
              onCallService: async (call) => {
                calls.push(call);
              },
            }),
          ),
        );
      };
      const power = () => document.querySelector(".light-dimmer__power");
      try {
        await render();
        assert.equal(document.querySelectorAll(".room-module").length, 1);
        assert.equal(document.querySelector(".room-module h2").textContent, "Kitchen pendants");
        assert.equal(document.querySelector('[aria-label="Reorder devices"]'), null);
        await act(async () => power().click());
        assert.deepEqual(calls[0], {
          domain: "light",
          service: "turn_off",
          data: undefined,
          target: { entity_id: "light.kitchen_pendants" },
        });
        const slider = document.querySelector('input[type="range"]');
        slider.attachEvent = () => undefined;
        slider.detachEvent = () => undefined;
        await act(async () => slider.focus());
        await act(async () =>
          slider.dispatchEvent(
            new document.defaultView.KeyboardEvent("keydown", {
              key: "ArrowUp",
              bubbles: true,
            }),
          ),
        );
        assert.equal(calls[1].domain, "light");
        assert.equal(calls[1].service, "turn_on");
        assert.equal(calls[1].data.brightness_pct, 51);
        assert.deepEqual(calls[1].target, { entity_id: "light.kitchen_pendants" });
        for (const device of room.devices) {
          await render(device.id);
          assert.equal(document.querySelectorAll(".room-module").length, 1);
          assert.equal(document.querySelector("h1").textContent, "Kitchen pendants");
          assert.ok(power());
        }
        for (const update of [
          { state: "unavailable", available: false },
          { state: "on", available: true, stale: true },
        ]) {
          Object.assign(runtime.entityStates["light.kitchen_pendants"], update);
          await render();
          assert.equal(power().disabled, true);
        }
        Object.assign(runtime.entityStates["light.kitchen_pendants"], {
          available: true,
          stale: false,
        });
        runtime.entityRegistry.find(
          (entry) => entry.entity_id === "light.kitchen_pendants",
        ).disabled_by = "user";
        await render();
        assert.equal(power().disabled, true);
        runtime.canMutate = false;
        runtime.status = "disconnected";
        await render();
        assert.equal(power().disabled, true);
        assert.equal(calls.length, 2, "Cabane dispatches only to the group, never expands members");
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  test("a device panel opens for the Outside rooms group, which has no room status", async () => {
    const { manifest, room, profile, runtime } = lightGroupFixture(neutralDemoManifest);
    const floor = manifest.floors[0];
    const device = room.devices[0];
    room.devices = room.devices.slice(1);
    manifest.sceneItems = [
      {
        id: device.id,
        kind: "device",
        modelId: device.model,
        floorId: floor.id,
        size: stableDeviceRegistry[device.model].defaultSize,
        placement: { kind: "absolute", at: [-5, -5], elevationMeters: 2.2, rotationYRadians: 0 },
        entitySlots: device.entitySlots,
      },
    ];
    const outside = `outside-rooms:${floor.id}`;
    await withStorageDom(async ({ document }) => {
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      const resolved = resolveHomeAssistantBindings(manifest, profile, runtime);
      try {
        await act(async () =>
          root.render(
            React.createElement(RoomControlSheet, {
              resolved: resolved.rooms[outside],
              roomStatus: deriveRoomStatusMap(manifest, profile, resolved, runtime)[outside],
              status: runtime.status,
              canMutate: runtime.canMutate,
              selectedDeviceId: device.id,
              onSelectDevice() {},
              onHome() {},
              onWalk() {},
              onConnectDevices() {},
              onReconnect() {},
              onRetry() {},
              onCallService: async () => {},
            }),
          ),
        );
        assert.equal(document.querySelector(".room-module h2").textContent, "Kitchen pendants");
        assert.equal(
          document.querySelector('[aria-label*="not connected"]'),
          null,
          "a device group is not an unmapped room",
        );
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  test("three separate scene emitters follow the shared group's confirmed brightness and power", async () => {
    const { manifest, room, profile, runtime } = lightGroupFixture(neutralDemoManifest);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const props = () => ({
      floor: manifest.floors[0],
      resolvedBindings: resolveHomeAssistantBindings(manifest, profile, runtime),
      deviceModels: stableDeviceRegistry,
      extensionDeviceModels: {},
    });
    const renderer = await create(React.createElement(HomeAssistantSceneLighting, props()));
    try {
      for (const device of room.devices) {
        const emitter = renderer.scene.findByProps({ name: `ha-device-light-${device.id}` });
        assert.ok(emitter.instance.intensity > 0);
        assert.equal(
          emitter.instance.intensity,
          (stableDeviceRegistry[device.model].sceneLight.maxIntensity * 128) / 255,
        );
      }
      runtime.entityStates["light.kitchen_pendants"].state = "off";
      await renderer.update(React.createElement(HomeAssistantSceneLighting, props()));
      for (const device of room.devices)
        assert.equal(
          renderer.scene.findByProps({ name: `ha-device-light-${device.id}` }).instance.intensity,
          0,
        );
    } finally {
      await renderer.unmount();
    }
  });

  test("an emitter outside every room follows its Home Assistant light", async () => {
    const { manifest, room, profile, runtime } = lightGroupFixture(neutralDemoManifest);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const floor = manifest.floors[0];
    const device = room.devices[0];
    room.devices = room.devices.slice(1);
    manifest.sceneItems = [
      {
        id: device.id,
        kind: "device",
        modelId: device.model,
        floorId: floor.id,
        size: stableDeviceRegistry[device.model].defaultSize,
        placement: { kind: "absolute", at: [-5, -5], elevationMeters: 2.2, rotationYRadians: 0 },
        entitySlots: device.entitySlots,
      },
    ];
    const props = () => ({
      floor,
      resolvedBindings: resolveHomeAssistantBindings(manifest, profile, runtime),
      deviceModels: stableDeviceRegistry,
      extensionDeviceModels: {},
      sceneItems: manifest.sceneItems,
    });
    const emitter = (renderer) =>
      renderer.scene.findByProps({ name: `ha-device-light-${device.id}` }).instance;
    const renderer = await create(React.createElement(HomeAssistantSceneLighting, props()));
    try {
      assert.equal(
        emitter(renderer).intensity,
        (stableDeviceRegistry[device.model].sceneLight.maxIntensity * 128) / 255,
      );
      runtime.entityStates["light.kitchen_pendants"].state = "off";
      await renderer.update(React.createElement(HomeAssistantSceneLighting, props()));
      assert.equal(emitter(renderer).intensity, 0);
    } finally {
      await renderer.unmount();
    }
  });
});
