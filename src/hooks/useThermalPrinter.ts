import { useCallback, useEffect, useRef, useState } from "react";

/** Split a byte stream into ≤ size chunks for BLE writeWithoutResponse. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return out;
}

const PRINT_SERVICE = 0x18f0;
const PRINT_CHAR = 0x2af1;
const MTU = 180;            // conservative BLE payload; tune on-device
const PACE_MS = 20;         // gap between chunks so the buffer drains

export type PrinterStatus =
  | "unsupported" | "disconnected" | "connecting" | "connected" | "printing" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useThermalPrinter() {
  const [status, setStatus] = useState<PrinterStatus>(
    typeof navigator !== "undefined" && navigator.bluetooth ? "disconnected" : "unsupported",
  );
  const charRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);

  const bind = useCallback(async (device: BluetoothDevice) => {
    deviceRef.current = device;
    device.addEventListener("gattserverdisconnected", () => {
      charRef.current = null;
      setStatus("disconnected");
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(PRINT_SERVICE);
    charRef.current = await service.getCharacteristic(PRINT_CHAR);
    setStatus("connected");
  }, []);

  // Auto-reconnect via previously-granted devices (no picker). Probes ONLY from
  // the idle "disconnected" state — this both prevents a connecting<->connected
  // re-bind loop AND gives free auto-reconnect when the printer later drops
  // (the gattserverdisconnected handler sets status back to "disconnected",
  // which re-fires this effect).
  useEffect(() => {
    if (status !== "disconnected") return;
    let cancelled = false;
    (async () => {
      try {
        const devices = await navigator.bluetooth.getDevices();
        const known = devices.find((d) => d.name === "BlueTooth Printer") ?? devices[0];
        if (known && !cancelled) {
          setStatus("connecting");
          await bind(known);
        }
      } catch {
        /* no grant yet — stay disconnected */
      }
    })();
    return () => { cancelled = true; };
  }, [status, bind]);

  const connect = useCallback(async () => {
    if (!navigator.bluetooth) return;
    setStatus("connecting");
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [PRINT_SERVICE] }, { namePrefix: "BlueTooth" }],
        optionalServices: [PRINT_SERVICE],
      });
      await bind(device);
    } catch {
      setStatus("disconnected"); // user cancelled chooser
    }
  }, [bind]);

  const disconnect = useCallback(() => {
    deviceRef.current?.gatt?.disconnect();
    charRef.current = null;
    setStatus("disconnected");
  }, []);

  const print = useCallback(async (bytes: Uint8Array) => {
    const ch = charRef.current;
    if (!ch) throw new Error("PRINTER_NOT_CONNECTED");
    setStatus("printing");
    try {
      for (const chunk of chunkBytes(bytes, MTU)) {
        // Copy into a fresh ArrayBuffer-backed view: chunkBytes uses subarray,
        // so chunk.buffer is ArrayBufferLike (may be SharedArrayBuffer), which
        // BufferSource rejects under TS 5.7+ typed-array generics.
        await ch.writeValueWithoutResponse(new Uint8Array(chunk));
        await sleep(PACE_MS);
      }
      setStatus("connected");
    } catch (err) {
      setStatus("error");
      throw err;
    }
  }, []);

  return { status, connect, disconnect, print };
}
