import type { Storage } from '@kohaku-eth/plugins';
import type { Hex } from 'viem';

import { deserializeHandle, serializeHandle } from './serialize';
import { type BridgeCallbacks, type BridgeHandle, type BridgeIntent, BridgeState } from './types';

const STORAGE_PREFIX = 'train-bridge:';
const INDEX_KEY = 'train-bridge:index';

/** Permitted forward transitions. A state can always "transition" to itself (idempotent patch). */
const ALLOWED: Record<BridgeState, BridgeState[]> = {
  [BridgeState.Created]: [BridgeState.SourceLocked, BridgeState.Failed],
  [BridgeState.SourceLocked]: [BridgeState.Filled, BridgeState.TimedOut, BridgeState.Failed],
  [BridgeState.Filled]: [BridgeState.Completed, BridgeState.Failed],
  [BridgeState.TimedOut]: [BridgeState.Refunded, BridgeState.Failed],
  [BridgeState.Completed]: [],
  [BridgeState.Refunded]: [],
  [BridgeState.Failed]: [],
};

export function canTransition(from: BridgeState, to: BridgeState): boolean {
  return from === to || ALLOWED[from]?.includes(to) === true;
}

/** Return a new handle moved to `to` (with `updatedAt` bumped); throws on an illegal transition. */
export function transition(handle: BridgeHandle, to: BridgeState, patch: Partial<BridgeHandle> = {}): BridgeHandle {
  if (!canTransition(handle.state, to)) {
    throw new Error(`illegal bridge transition: ${handle.state} -> ${to}`);
  }

  return { ...handle, ...patch, state: to, updatedAt: new Date().toISOString() };
}

function storageKey(hashlock: Hex): string {
  return STORAGE_PREFIX + hashlock.toLowerCase();
}

function readIndex(storage: Storage): string[] {
  const raw = storage.get(INDEX_KEY);

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Persist a handle and keep the hashlock index up to date (Storage has no key enumeration). */
export function saveHandle(storage: Storage, handle: BridgeHandle): void {
  storage.set(storageKey(handle.hashlock), serializeHandle(handle));
  const index = readIndex(storage);
  const key = handle.hashlock.toLowerCase();

  if (!index.includes(key)) {
    index.push(key);
    storage.set(INDEX_KEY, JSON.stringify(index));
  }
}

export function loadHandle(storage: Storage, hashlock: Hex): BridgeHandle | null {
  const raw = storage.get(storageKey(hashlock));

  return raw ? deserializeHandle(raw) : null;
}

/** All bridges this storage has seen (for an "in-flight bridges" UI across reloads). */
export function listHandles(storage: Storage): BridgeHandle[] {
  return readIndex(storage)
    .map((h) => storage.get(STORAGE_PREFIX + h))
    .filter((v): v is string => v !== null)
    .map(deserializeHandle);
}

/** Create a fresh handle for an intent in the CREATED state. */
export function newHandle(intent: BridgeIntent): BridgeHandle {
  const now = new Date().toISOString();

  return { hashlock: intent.hashlock, state: BridgeState.Created, intent, createdAt: now, updatedAt: now };
}

/** Persist a handle (if storage given) and notify the state-change callback. Returns the handle. */
export function commit(
  handle: BridgeHandle,
  opts: { storage?: Storage; callbacks?: BridgeCallbacks } = {},
): BridgeHandle {
  if (opts.storage) saveHandle(opts.storage, handle);

  opts.callbacks?.onStateChange?.(handle);

  return handle;
}
