import { pointInsidePolygon } from "./geometry";
import { deviceSlotForItem } from "./home-project/runtime";
import type { HomeBindingManifest, RoomSpec } from "./types";

/** Binding group id for a floor's devices outside every room. */
export const outsideRoomsGroupId = (floorId: string) => `outside-rooms:${floorId}`;

/** A device-list group only; never added to architectural floor rooms. */
export function outsideRoomDevices(
  manifest: HomeBindingManifest,
  floorId: string,
): RoomSpec | null {
  const floor = manifest.floors.find((candidate) => candidate.id === floorId);
  if (!floor) return null;
  const devices = manifest.sceneItems.flatMap((item) => {
    if (item.kind !== "device" || item.floorId !== floorId) return [];
    try {
      const device = deviceSlotForItem(item, floor);
      return floor.rooms.some((room) => pointInsidePolygon(device.placement.at, room.polygon))
        ? []
        : [device];
    } catch {
      return [];
    }
  });
  return devices.length
    ? {
        id: outsideRoomsGroupId(floorId),
        name: "Outside rooms",
        // Non-spatial adapter for the existing room-based mapping components.
        polygon: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        accent: "#74856a",
        dashboardSlots: [],
        devices,
      }
    : null;
}

export function deviceMappingRooms(
  manifest: HomeBindingManifest,
  floorId?: string,
): readonly RoomSpec[] {
  return manifest.floors
    .filter((floor) => !floorId || floor.id === floorId)
    .flatMap((floor) => {
      const outside = outsideRoomDevices(manifest, floor.id);
      return [...floor.rooms, ...(outside ? [outside] : [])];
    });
}
