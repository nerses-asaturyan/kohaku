import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { deserializeHandle, serializeHandle } from '../src/serialize';
import { newHandle } from '../src/state';
import { type BridgeIntent, BridgeState } from '../src/types';

const intent = {
  kind: 'erc20',
  createdAt: '2026-05-29T00:00:00.000Z',
  r: '1',
  secret: '2',
  hashlock: ('0x' + '9'.repeat(64)) as Hex,
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

describe('serialize', () => {
  it('round-trips a handle (JSON-safe by construction)', () => {
    const h = newHandle(intent);

    expect(deserializeHandle(serializeHandle(h))).toEqual(h);
  });

  it('advancing state survives a storage round-trip', () => {
    const h = { ...newHandle(intent), state: BridgeState.Filled, solverIndex: '2', dstTxHash: '0xfeed' as Hex };
    const back = deserializeHandle(serializeHandle(h));

    expect(back.state).toBe(BridgeState.Filled);
    expect(back.solverIndex).toBe('2');
  });

  it('rejects malformed input', () => {
    expect(() => deserializeHandle('{}')).toThrow();
    expect(() => deserializeHandle('not json')).toThrow();
  });
});
