import type { BridgeHandle } from './types';

/**
 * `BridgeHandle` is JSON-safe by construction (bigints stored as decimal strings,
 * addresses/hashes as hex), so (de)serialization is thin — these wrappers
 * centralize it and add a light structural guard for storage round-trips.
 */
export function serializeHandle(handle: BridgeHandle): string {
  return JSON.stringify(handle);
}

export function deserializeHandle(raw: string): BridgeHandle {
  const handle = JSON.parse(raw) as BridgeHandle;

  if (!handle || typeof handle !== 'object' || !handle.hashlock || !handle.state || !handle.intent) {
    throw new Error('invalid serialized BridgeHandle');
  }

  return handle;
}
