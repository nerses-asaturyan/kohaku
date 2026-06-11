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

export type VerifyResult = {
  ok: boolean;
  reasons: string[];
  /** True when the failure is a CONTRADICTION (e.g. reverted receipt) rather than possibly-stale
   *  reads — definitive failures stop the retry loop early. */
  definitive?: boolean;
};

export type VerifyOpts = { timeoutMs?: number; intervalMs?: number };

/**
 * Trustlessly verify the destination redeem+shield happened:
 *   1. the redeemAndShield receipt succeeded,
 *   2. a `ShieldedRedeemed` event for (hashlock, index) was emitted by the receiver,
 *   3. the solver lock is now `Redeemed`.
 *
 * PATIENT by design: right after the redeem mines, a load-balanced RPC node can briefly return no
 * receipt or a stale solver-lock state. Those are INCONCLUSIVE, not failures — this retries until
 * the window closes, and only a contradiction (reverted receipt) fails fast. A thrown provider
 * error during an attempt is also treated as inconclusive (never escalate a transient read error
 * into a FAILED bridge — the redeem may have succeeded).
 */
export async function verifyShieldedRedeem(
  provider: EthereumProvider,
  args: VerifyArgs,
  opts: VerifyOpts = {},
): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  let last: VerifyResult = { ok: false, reasons: ['verification did not run'] };

  for (;;) {
    try {
      last = await verifyShieldedRedeemOnce(provider, args);
    } catch (e) {
      last = { ok: false, reasons: [`verification read error: ${(e as Error)?.message ?? e}`] };
    }

    if (last.ok || last.definitive || Date.now() >= deadline) return last;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** One verification pass against the current provider view (no retries). */
export async function verifyShieldedRedeemOnce(provider: EthereumProvider, args: VerifyArgs): Promise<VerifyResult> {
  const reasons: string[] = [];
  let ok = true;

  const receipt = await provider.getTransactionReceipt(args.txHash);

  if (!receipt) return { ok: false, reasons: ['no receipt for redeemAndShield tx'] };

  if (receipt.status !== 1n) {
    // A mined-and-reverted redeem is a real contradiction — no amount of waiting changes it.
    return { ok: false, reasons: [`redeemAndShield reverted (status ${receipt.status})`], definitive: true };
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
