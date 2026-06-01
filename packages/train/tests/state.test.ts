import type { Storage } from '@kohaku-eth/plugins';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { canTransition, listHandles, loadHandle, newHandle, saveHandle, transition } from '../src/state';
import { type BridgeIntent, BridgeState } from '../src/types';

class MemStore implements Storage {
  readonly _brand = 'Storage' as const;
  private store = new Map<string, string>();
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }
}

function makeIntent(hashlock: Hex): BridgeIntent {
  return {
    kind: 'erc20',
    createdAt: '2026-05-29T00:00:00.000Z',
    r: '1',
    secret: '2',
    hashlock,
    template: {
      npk: ('0x' + '1'.repeat(64)) as Hex,
      token: { tokenType: 0, tokenAddress: '0x' + '3'.repeat(40), tokenSubID: '0' },
      encryptedBundle: [('0x' + 'a'.repeat(64)) as Hex, ('0x' + 'b'.repeat(64)) as Hex, ('0x' + 'c'.repeat(64)) as Hex],
      shieldKey: ('0x' + 'd'.repeat(64)) as Hex,
    },
    srcChainId: 421614,
    dstChainId: 11155111,
    srcTrainAddress: '0x' + '4'.repeat(40),
    dstTrainToken: '0x' + '5'.repeat(40),
    shieldToken: '0x' + '5'.repeat(40),
    shieldedReceiverAddress: '0x' + '6'.repeat(40),
    railgunAddress: '0zktest',
    unshieldToken: '0x' + '7'.repeat(40),
    lockAmount: '1000',
    grossUnshield: '1003',
    userLockCalldata: '0xdead' as Hex,
    userLockValueWei: '0',
  } as BridgeIntent;
}

describe('state machine', () => {
  it('starts in CREATED', () => {
    const h = newHandle(makeIntent(('0x' + '9'.repeat(64)) as Hex));

    expect(h.state).toBe(BridgeState.Created);
  });

  it('allows the happy path and rejects skips', () => {
    const h = newHandle(makeIntent(('0x' + '9'.repeat(64)) as Hex));
    const locked = transition(h, BridgeState.SourceLocked, { srcTxHash: '0xabc' as Hex });

    expect(locked.state).toBe(BridgeState.SourceLocked);
    expect(locked.srcTxHash).toBe('0xabc');
    const filled = transition(locked, BridgeState.Filled, { solverIndex: '1' });
    const completed = transition(filled, BridgeState.Completed);

    expect(completed.state).toBe(BridgeState.Completed);

    expect(() => transition(h, BridgeState.Completed)).toThrow();
    expect(() => transition(completed, BridgeState.Refunded)).toThrow();
  });

  it('canTransition encodes the allowed graph', () => {
    expect(canTransition(BridgeState.SourceLocked, BridgeState.TimedOut)).toBe(true);
    expect(canTransition(BridgeState.TimedOut, BridgeState.Refunded)).toBe(true);
    expect(canTransition(BridgeState.Filled, BridgeState.Completed)).toBe(true);
    expect(canTransition(BridgeState.Completed, BridgeState.SourceLocked)).toBe(false);
    expect(canTransition(BridgeState.Created, BridgeState.Created)).toBe(true); // idempotent
  });
});

describe('persistence', () => {
  it('saves, loads, and lists handles without duplicating the index', () => {
    const storage = new MemStore();
    const hashlock = ('0x' + '9'.repeat(64)) as Hex;
    const h = newHandle(makeIntent(hashlock));

    saveHandle(storage, h);
    saveHandle(storage, transition(h, BridgeState.SourceLocked)); // same hashlock, updated state

    const loaded = loadHandle(storage, hashlock);

    expect(loaded?.state).toBe(BridgeState.SourceLocked);
    expect(listHandles(storage)).toHaveLength(1);
    expect(loadHandle(storage, ('0x' + '0'.repeat(64)) as Hex)).toBeNull();
  });
});
