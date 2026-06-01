import type { EthereumProvider } from '@kohaku-eth/provider';
import { type Hex, decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress } from 'viem';

import { LOCK_STATUS, SHIELDED_RECEIVER_ABI, TRAIN_ABI } from './abis';

export type VerifyArgs = {
  hashlock: Hex;
  solverIndex: bigint;
  dstTrainAddress: `0x${string}`;
  shieldedReceiver: `0x${string}`;
  txHash: Hex;
};

export type VerifyResult = { ok: boolean; reasons: string[] };

/**
 * Trustlessly verify the destination redeem+shield happened, against a
 * Helios-verified view of Ethereum Sepolia:
 *   1. the redeemAndShield receipt succeeded,
 *   2. a `ShieldedRedeemed` event for (hashlock, index) was emitted by the receiver,
 *   3. the solver lock is now `Redeemed`.
 */
export async function verifyShieldedRedeem(provider: EthereumProvider, args: VerifyArgs): Promise<VerifyResult> {
  const reasons: string[] = [];
  let ok = true;

  const receipt = await provider.getTransactionReceipt(args.txHash);

  if (!receipt) return { ok: false, reasons: ['no receipt for redeemAndShield tx'] };

  if (receipt.status !== 1n) {
    ok = false;
    reasons.push(`redeemAndShield reverted (status ${receipt.status})`);
  }

  let sawEvent = false;

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(args.shieldedReceiver)) continue;

    try {
      const ev = decodeEventLog({
        abi: SHIELDED_RECEIVER_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evArgs = ev.args as any;

      if (
        ev.eventName === 'ShieldedRedeemed' &&
        String(evArgs.hashlock).toLowerCase() === args.hashlock.toLowerCase() &&
        BigInt(evArgs.index) === args.solverIndex
      ) {
        sawEvent = true;
        break;
      }
    } catch {
      // not our event
    }
  }

  if (!sawEvent) {
    ok = false;
    reasons.push('no ShieldedRedeemed event matched (hashlock, index)');
  }

  const data = encodeFunctionData({ abi: TRAIN_ABI, functionName: 'getSolverLock', args: [args.hashlock, args.solverIndex] });
  const res = await provider.call({ to: args.dstTrainAddress, input: data });

  if (res) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lock = decodeFunctionResult({ abi: TRAIN_ABI, functionName: 'getSolverLock', data: res }) as any;

    if (Number(lock.status) !== LOCK_STATUS.Redeemed) {
      ok = false;
      reasons.push(`solver lock status ${lock.status} != Redeemed`);
    }
  } else {
    reasons.push('could not read solver lock status');
  }

  return { ok, reasons };
}
