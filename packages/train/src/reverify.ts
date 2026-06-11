import type { Host, Storage } from '@kohaku-eth/plugins';
import { getAddress } from 'viem';

import { trainChain } from './config';
import { commit, transition } from './state';
import { type BridgeCallbacks, type BridgeHandle, BridgeState } from './types';
import { verifyShieldedRedeem } from './verify';

export type ReverifyArgs = {
  /** Destination host — its provider performs the verification reads. */
  dstHost: Host;
  handle: BridgeHandle;
  storage?: Storage;
  callbacks?: BridgeCallbacks;
};

/**
 * Recovery path for a handle that FAILED *verification* even though its redeem was broadcast
 * (handle has a dstTxHash): re-run the (patient) verification now that any RPC propagation lag
 * has long passed, and promote FAILED → COMPLETED when the redeem checks out. The on-chain swap
 * already happened in that case — only the handle's label was wrong.
 *
 * Idempotent: an already-COMPLETED handle is returned as-is; a still-failing verification keeps
 * the handle FAILED with an updated error message.
 */
export async function reverifyShieldedRedeem(args: ReverifyArgs): Promise<BridgeHandle> {
  let handle = args.handle;
  const ctx = { storage: args.storage ?? args.dstHost.storage, callbacks: args.callbacks };
  const { intent } = handle;

  if (handle.state === BridgeState.Completed) return handle;
  if (!handle.dstTxHash) throw new Error('reverify requires a dstTxHash (no redeem was broadcast)');
  if (!handle.solverIndex) throw new Error('reverify requires a solverIndex (run trackFill first)');

  const result = await verifyShieldedRedeem(args.dstHost.provider, {
    hashlock: intent.hashlock,
    solverIndex: BigInt(handle.solverIndex),
    dstTrainAddress: trainChain(intent.dstChainId).trainContract,
    shieldedReceiver: getAddress(intent.shieldedReceiverAddress),
    txHash: handle.dstTxHash,
  });

  if (result.ok) {
    handle = transition(handle, BridgeState.Completed, { error: undefined });

    return commit(handle, ctx);
  }

  // Still not verifiable — keep FAILED but record the current reasons (self-transition patch).
  handle = transition(handle, handle.state, {
    error: `destination verification still failing: ${result.reasons.join('; ')}`,
  });

  return commit(handle, ctx);
}
