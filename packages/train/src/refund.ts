import type { Host, Storage } from '@kohaku-eth/plugins';
import type { TxData, TxSigner } from '@kohaku-eth/provider';
import { type Hex, encodeFunctionData, getAddress } from 'viem';

import { TRAIN_ABI } from './abis';
import { commit, transition } from './state';
import { type BridgeCallbacks, type BridgeHandle, BridgeState } from './types';

export type RefundBridgeArgs = {
  /** Source host (Arbitrum Sepolia). */
  srcHost: Host;
  handle: BridgeHandle;
  /** Funded source EOA that broadcasts refundUser (after the timelock). */
  relayer: TxSigner;
  storage?: Storage;
  callbacks?: BridgeCallbacks;
};

/**
 * Timeout path: reclaim the unfilled source lock via `Train.refundUser(hashlock)`.
 * Only succeeds once the on-chain timelock has elapsed (contract-enforced).
 * Advances the handle from TIMED_OUT to REFUNDED.
 */
export async function refundBridge(args: RefundBridgeArgs): Promise<BridgeHandle> {
  let handle = args.handle;
  const ctx = { storage: args.storage ?? args.srcHost.storage, callbacks: args.callbacks };
  const { intent } = handle;

  const data = encodeFunctionData({ abi: TRAIN_ABI, functionName: 'refundUser', args: [intent.hashlock] });
  const txData: TxData = { to: getAddress(intent.srcTrainAddress), data, value: 0n };

  const hash = (await args.relayer.sendTransaction(txData)) as Hex;

  await args.srcHost.provider.waitForTransaction(hash);

  handle = transition(handle, BridgeState.Refunded, { refundTxHash: hash });

  return commit(handle, ctx);
}
