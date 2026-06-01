import type { Host, Storage } from '@kohaku-eth/plugins';
import type { TxData, TxSigner } from '@kohaku-eth/provider';
import { type Hex, encodeFunctionData, getAddress } from 'viem';

import { SHIELDED_RECEIVER_ABI } from './abis';
import { templateToTuple } from './binding';
import { trainChain } from './config';
import { commit, transition } from './state';
import { type BridgeCallbacks, type BridgeHandle, BridgeState } from './types';
import { verifyShieldedRedeem } from './verify';

export type CompleteShieldArgs = {
  /** Destination host (Ethereum Sepolia); its provider should be Helios for trustless verification. */
  dstHost: Host;
  handle: BridgeHandle;
  /** Funded dst EOA that broadcasts redeemAndShield (a gas relayer; unlinkable to the recipient). */
  relayer: TxSigner;
  /** Verify the redeem on-chain via the dst provider (default: true). */
  verify?: boolean;
  storage?: Storage;
  callbacks?: BridgeCallbacks;
};

/**
 * Atomic destination redeem+shield: calls `ShieldedReceiver.redeemAndShield`,
 * which redeems the solver lock and shields the payout into the user's dst 0zk.
 * Advances the handle to COMPLETED (or FAILED if verification fails).
 */
export async function completeShield(args: CompleteShieldArgs): Promise<BridgeHandle> {
  let handle = args.handle;
  const ctx = { storage: args.storage ?? args.dstHost.storage, callbacks: args.callbacks };
  const { intent } = handle;

  if (!handle.solverIndex) throw new Error('completeShield requires a solverIndex (run trackFill first)');

  const data = encodeFunctionData({
    abi: SHIELDED_RECEIVER_ABI,
    functionName: 'redeemAndShield',
    args: [
      intent.hashlock,
      BigInt(handle.solverIndex),
      BigInt(intent.r),
      getAddress(intent.dstTrainToken),
      templateToTuple(intent.template),
    ],
  });

  const txData: TxData = { to: getAddress(intent.shieldedReceiverAddress), data, value: 0n };

  args.callbacks?.onProgress?.({ step: BridgeState.Completed, current: 0, total: 1, note: 'redeemAndShield' });

  const hash = (await args.relayer.sendTransaction(txData)) as Hex;

  await args.dstHost.provider.waitForTransaction(hash);

  if (args.verify !== false) {
    const result = await verifyShieldedRedeem(args.dstHost.provider, {
      hashlock: intent.hashlock,
      solverIndex: BigInt(handle.solverIndex),
      dstTrainAddress: trainChain(intent.dstChainId).trainContract,
      shieldedReceiver: getAddress(intent.shieldedReceiverAddress),
      txHash: hash,
    });

    if (!result.ok) {
      handle = transition(handle, BridgeState.Failed, {
        dstTxHash: hash,
        error: `destination verification failed: ${result.reasons.join('; ')}`,
      });

      return commit(handle, ctx);
    }
  }

  handle = transition(handle, BridgeState.Completed, { dstTxHash: hash });

  return commit(handle, ctx);
}
