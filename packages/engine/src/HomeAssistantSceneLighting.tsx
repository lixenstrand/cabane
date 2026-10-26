import { useContext, useMemo } from "react";
import type { SceneLightWallPlane } from "./scene-light-wall-mask";
import { resolveModelVariant } from "./model-variants";
import { SceneNightContext, sceneLightState } from "./scene-light-state";
import {
  deviceWorldTransform,
  resolveDeviceModelDefinition,
  uniformDeviceScaleForSize,
} from "./devices";
import {
  findContainingRoom,
  planPointToWorld,
  polygonCentroid,
  worldPointToPlan,
} from "./geometry";
import { resolveItemTransform, type SceneItemSpec } from "./home-project";
import { lightBrightnessRatio, lightColorForSnapshot } from "./home-assistant-controls";
import { outsideRoomsGroupId } from "./outside-room-devices";
import type { DeviceModelRegistry, FloorSpec, ResolvedHomeBindings, RoomSpec } from "./types";

const defaultRoomLight = (room: RoomSpec, floor: FloorSpec) => {
  const [x, z] = planPointToWorld(polygonCentroid(room.polygon), floor.coordinates);
  const worldPoints = room.polygon.map((point) => planPointToWorld(point, floor.coordinates));
  const xs = worldPoints.map(([worldX]) => worldX);
  const zs = worldPoints.map(([, worldZ]) => worldZ);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return {
    position: [x, floor.defaultCeilingHeightMeters - 0.35, z] as const,
    color: "#ffd99b",
    maxIntensity: 5,
    distance: Math.max(4, Math.min(8, span * 1.1)),
  };
};

const deviceLightPosition = (
  position: readonly [number, number, number],
  rotationYRadians: number,
  scale: number,
  local: readonly [number, number, number],
): readonly [number, number, number] => {
  const cosine = Math.cos(rotationYRadians);
  const sine = Math.sin(rotationYRadians);
  const localX = local[0] * scale;
  const localZ = local[2] * scale;
  return [
    position[0] + localX * cosine + localZ * sine,
    position[1] + local[1] * scale,
    position[2] - localX * sine + localZ * cosine,
  ];
};

// Restrict receivers behind the wall, never the hemisphere behind the bulb.
const lightWallPlane = (
  floor: FloorSpec,
  position: readonly [number, number, number],
  distance: number,
): SceneLightWallPlane | null => {
  const point = worldPointToPlan({ x: position[0], z: position[2] }, floor.coordinates);
  if (!findContainingRoom(point, floor.rooms)) return null;
  const threshold = Math.min(0.6, distance * 0.25);
  let nearest: SceneLightWallPlane | null = null;
  let nearestDistance = threshold;
  for (const wall of floor.walls) {
    if (position[1] > (wall.heightMeters ?? floor.defaultWallHeightMeters)) continue;
    const [startX, startZ] = planPointToWorld(wall.from, floor.coordinates);
    const [endX, endZ] = planPointToWorld(wall.to, floor.coordinates);
    const dx = endX - startX;
    const dz = endZ - startZ;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared === 0) continue;
    const fraction = Math.max(
      0,
      Math.min(1, ((position[0] - startX) * dx + (position[2] - startZ) * dz) / lengthSquared),
    );
    const awayX = position[0] - (startX + fraction * dx);
    const awayZ = position[2] - (startZ + fraction * dz);
    const separation = Math.hypot(awayX, awayZ);
    if (separation < 0.01 || separation >= nearestDistance) continue;
    const wallPlanLength = Math.hypot(wall.to[0] - wall.from[0], wall.to[1] - wall.from[1]);
    const throughOpening = floor.openings.some(
      (opening) =>
        opening.wallId === wall.id &&
        fraction * wallPlanLength >= opening.offsetFromWallStartPlanUnits &&
        fraction * wallPlanLength <=
          opening.offsetFromWallStartPlanUnits + opening.widthPlanUnits &&
        position[1] >= opening.sillHeightMeters &&
        position[1] <= opening.sillHeightMeters + opening.openingHeightMeters,
    );
    if (throughOpening) continue;
    nearestDistance = separation;
    const nx = awayX / separation,
      nz = awayZ / separation;
    const innerX = startX + fraction * dx + (nx * wall.thicknessMeters) / 2;
    const innerZ = startZ + fraction * dz + (nz * wall.thicknessMeters) / 2;
    nearest = [nx, 0, nz, -(nx * innerX + nz * innerZ)];
  }
  return nearest;
};

function PhysicalSceneLight({
  floor,
  name,
  position,
  color,
  intensity,
  distance,
}: {
  floor: FloorSpec;
  name: string;
  position: readonly [number, number, number];
  color: string;
  intensity: number;
  distance: number;
}) {
  const [x, y, z] = position;
  const plane = useMemo(
    () => lightWallPlane(floor, [x, y, z], distance),
    [floor, x, y, z, distance],
  );
  return (
    <pointLight
      name={name}
      position={position}
      color={color}
      intensity={intensity}
      distance={distance}
      decay={2}
      castShadow={false}
      userData={{ cabaneLightWallPlane: plane }}
    />
  );
}

export function HomeAssistantSceneLighting({
  floor,
  resolvedBindings,
  deviceModels,
  extensionDeviceModels,
  sceneItems = [],
  enabled = true,
}: {
  floor: FloorSpec;
  resolvedBindings: ResolvedHomeBindings;
  deviceModels: DeviceModelRegistry;
  extensionDeviceModels: DeviceModelRegistry;
  sceneItems?: readonly SceneItemSpec[];
  enabled?: boolean | undefined;
}) {
  const nightLighting = useContext(SceneNightContext);
  if (!enabled) return <group name="home-assistant-scene-lighting" />;
  // Bindings cover the whole building; fallback emitters belong only to this floor.
  const resolvedDevices = [
    ...floor.rooms.map((room) => room.id),
    outsideRoomsGroupId(floor.id),
  ].flatMap((roomId) => resolvedBindings.rooms[roomId]?.devices ?? []);
  const resolvedById = new Map(resolvedDevices.map((device) => [device.slot.id, device]));
  // Scene items exist independently of room assignment and HA connectivity.
  const deviceItems = sceneItems.filter((item) => item.kind === "device");
  const deviceItemIds = new Set(deviceItems.map((item) => item.id));
  const lightDevices = [
    ...deviceItems.map((item) => ({
      id: item.id,
      modelId: item.modelId,
      item,
      resolved: resolvedById.get(item.id),
    })),
    ...resolvedDevices
      .filter((device) => !deviceItemIds.has(device.slot.id))
      .map((resolved) => ({
        id: resolved.slot.id,
        modelId: resolved.slot.model,
        item: undefined,
        resolved,
      })),
  ];
  return (
    <group name="home-assistant-scene-lighting">
      {floor.rooms.flatMap((room) => {
        const resolvedRoom = resolvedBindings.rooms[room.id];
        if (!resolvedRoom) return [];
        const roomLights = Object.values(resolvedRoom.sections)
          .flat()
          .flatMap((entity) => {
            const slot = room.dashboardSlots.find((candidate) => candidate.id === entity.slotId);
            if (
              entity.domain !== "light" &&
              !(entity.domain === "switch" && slot?.compatibleDomains.includes("light"))
            )
              return [];
            const brightness = lightBrightnessRatio(entity.state);
            // Keep light counts stable: toggles update uniforms instead of recompiling shaders.
            const configured = slot?.sceneLight;
            const fallback = defaultRoomLight(room, floor);
            const configuredPosition = configured
              ? planPointToWorld(configured.at, floor.coordinates)
              : null;
            const resolvedPosition = configured
              ? ([
                  configuredPosition![0],
                  configured.elevationMeters,
                  configuredPosition![1],
                ] as const)
              : fallback.position;
            return [
              <PhysicalSceneLight
                floor={floor}
                key={`room-light-${entity.slotId}`}
                name={`ha-room-light-${entity.slotId}`}
                position={resolvedPosition}
                color={lightColorForSnapshot(entity.state, configured?.color ?? fallback.color)}
                intensity={(configured?.maxIntensity ?? fallback.maxIntensity) * brightness}
                distance={configured?.distance ?? fallback.distance}
              />,
            ];
          });
        return roomLights;
      })}
      {lightDevices.flatMap(({ id, modelId, item: sceneItem, resolved }) => {
        const definition = resolveDeviceModelDefinition(
          modelId,
          deviceModels,
          extensionDeviceModels,
        );
        if (
          !definition?.sceneLight ||
          resolveModelVariant(definition, sceneItem?.variant).sceneLight === false
        )
          return [];
        const primaryLightSlot = (sceneItem?.entitySlots ?? resolved?.slot.entitySlots)?.find(
          (slot) => slot.deviceRole === "primary" && slot.compatibleDomains.includes("light"),
        );
        const entity =
          resolved?.slot.model === modelId
            ? resolved.entities.find(
                (candidate) =>
                  (candidate.domain === "light" ||
                    (candidate.domain === "switch" && Boolean(primaryLightSlot))) &&
                  (!primaryLightSlot || candidate.slotId === primaryLightSlot.id),
              )
            : undefined;
        const transform = sceneItem
          ? resolveItemTransform(sceneItem.placement, floor)
          : deviceWorldTransform(resolved.slot, floor.coordinates);
        const state = sceneLightState(sceneItem?.lightState, entity?.state, nightLighting);
        const brightness = lightBrightnessRatio(state);
        // Zero-intensity emitters retain the shader layout while devices are off.
        const sceneItemScale = sceneItem
          ? uniformDeviceScaleForSize(sceneItem.size, definition)
          : null;
        if (sceneItem && sceneItemScale === null) return [];
        const scale = sceneItem
          ? sceneItemScale!
          : deviceWorldTransform(resolved.slot, floor.coordinates).scale;
        const source = definition.sceneLight;
        return [
          <PhysicalSceneLight
            floor={floor}
            key={`device-light-${id}`}
            name={`ha-device-light-${id}`}
            position={deviceLightPosition(
              transform.position,
              transform.rotationYRadians,
              scale,
              source.position,
            )}
            color={lightColorForSnapshot(state, source.color)}
            intensity={source.maxIntensity * brightness}
            distance={source.distance * scale}
          />,
        ];
      })}
    </group>
  );
}
