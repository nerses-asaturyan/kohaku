import type { Host, Storage } from '@kohaku-eth/plugins';
import { decodeFunctionResult, encodeFunctionData, getAddress } from 'viem';

import { LOCK_STATUS, TRAIN_ABI } from './abis';
import { DEFAULT_DISCOVER_INTERVAL_MS, DEFAULT_DISCOVER_TIMEOUT_MS, trainChain } from './config';
import { commit, transition } from './state';
import { type BridgeCallbacks, type BridgeHandle, BridgeState } from './types';

export type TrackFillArgs = {
  /** Destination host (Ethereum Sepolia) — its provider should be Helios for trustless reads. */
  dstHost: Host;
  handle: BridgeHandle;
  timeoutMs?: number;
  intervalMs?: number;
  storage?: Storage;
  callbacks?: BridgeCallbacks;
  /** Abort the polling loop early. */
  signal?: AbortSignal;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Poll the destination TRAIN for the solver's Pending lock (recipient ==
 * ShieldedReceiver, token == dstTrainToken). Advances the handle to FILLED with
 * the solverIndex, or TIMED_OUT after `timeoutMs`.
 */
export async function trackFill(args: TrackFillArgs): Promise<BridgeHandle> {
  let handle = args.handle;
  const ctx = { storage: args.storage ?? args.dstHost.storage, callbacks: args.callbacks };
  const provider = args.dstHost.provider;

  const { intent } = handle;
  const train = trainChain(intent.dstChainId).trainContract;
  const receiver = getAddress(intent.shieldedReceiverAddress);
  const wantToken = getAddress(intent.dstTrainToken);
  const { hashlock } = intent;

  const timeoutMs = args.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
  const intervalMs = args.intervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  const readCount = async (): Promise<bigint> => {
    const data = encodeFunctionData({ abi: TRAIN_ABI, functionName: 'getSolverLockCount', args: [hashlock] });
    const res = await provider.call({ to: train, input: data });

    if (!res) return 0n;

    return decodeFunctionResult({ abi: TRAIN_ABI, functionName: 'getSolverLockCount', data: res }) as bigint;
  };

  const readLock = async (index: bigint) => {
    const data = encodeFunctionData({ abi: TRAIN_ABI, functionName: 'getSolverLock', args: [hashlock, index] });
    const res = await provider.call({ to: train, input: data });

    if (!res) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return decodeFunctionResult({ abi: TRAIN_ABI, functionName: 'getSolverLock', data: res }) as any;
  };

  for (;;) {
    const count = await readCount();

    args.callbacks?.onProgress?.({
      step: BridgeState.SourceLocked,
      current: Number(count),
      total: Number(count),
      note: 'polling solver locks',
    });

    for (let i = 1n; i <= count; i++) {
      const lock = await readLock(i);

      if (!lock) continue;

      if (
        getAddress(lock.recipient) === receiver &&
        getAddress(lock.token) === wantToken &&
        Number(lock.status) === LOCK_STATUS.Pending
      ) {
        handle = transition(handle, BridgeState.Filled, { solverIndex: i.toString() });

        return commit(handle, ctx);
      }
    }

    if (Date.now() >= deadline) {
      handle = transition(handle, BridgeState.TimedOut, {
        error: `no matching Pending solver lock within ${timeoutMs}ms`,
      });

      return commit(handle, ctx);
    }

    await sleep(intervalMs, args.signal);
  }
}
