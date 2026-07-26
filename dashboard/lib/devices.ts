export interface Device {
  id: string;
  name: string;
  location: string;
}

// Placeholder registry until devices + locations are tracked in the DB.
// `id` must match the X-Device-Id the firmware sends (see DEVICE_ID in
// Project_Code_361.ino) so links resolve to real readings/photos.
export const DEVICES: Device[] = [
  { id: "esp32-node-01", name: "ESP32 Node 01", location: "DC Entrance" },
];

export function getDevice(id: string): Device | undefined {
  return DEVICES.find((d) => d.id === id);
}
