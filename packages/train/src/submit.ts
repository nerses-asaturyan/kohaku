import type { Host, Storage } from '@kohaku-eth/plugins';
import type { TxData, TxSigner } from '@kohaku-eth/provider';
import { type Hex, encodeFunctionData, getAddress } from 'viem';

import { ERC20_ABI, WETH_ABI } from './abis';
import type { RelayAdaptUnshieldFn } from './railgun';
import { commit, newHandle, transition } from './state';
import { type BridgeCallbacks, type BridgeHandle, type BridgeIntent, BridgeState } from './types';

export type SubmitIntentArgs = {
  /** Source chain host (Arbitrum Sepolia) — used to await the broadcast tx. */
  srcHost: Host;
  /** Funded, NON-custodial EOA broadcaster (pays Arb gas; never holds the funds). */
  broadcaster: TxSigner;
  intent: BridgeIntent;
  /** Adapter producing the proved RelayAdapt unshield+calls tx. */
  relayAdaptUnshield: RelayAdaptUnshieldFn;
  /** Source 0zk address that receives re-shielded change (the source wallet itself). */
  reshieldTo: string;
  /** Resume an existing handle; otherwise a fresh CREATED handle is made. */
  handle?: BridgeHandle;
  storage?: Storage;
  callbacks?: BridgeCallbacks;
};

/**
 * Source spend on Arbitrum Sepolia: one proved RelayAdapt cross-contract tx that
 * unshields WETH, runs `[approve(TRAIN, amount), userLock(...)]`, and re-shields
 * change — broadcast by a funded EOA. Advances the handle to SOURCE_LOCKED.
 */
export async function submitIntent(args: SubmitIntentArgs): Promise<BridgeHandle> {
  const { intent } = args;
  let handle = args.handle ?? newHandle(intent);
  const ctx = { storage: args.storage ?? args.srcHost.storage, callbacks: args.callbacks };

  // Persist the handle in CREATED state BEFORE building/broadcasting the lock. The intent holds the
  // only copy of the HTLC secret/r; if anything throws between sendTransaction and the final commit
  // (RPC waitForTransaction failure, a caller-side timeout, an extension reload) the WETH is locked
  // on-chain but the secret would otherwise live only in volatile UI state and be lost — stranding
  // the funds (no handle to resume/refund). Persisting first makes the lock recoverable via
  // listBridges()/resume() no matter what fails next.
  handle = commit(handle, ctx);

  args.callbacks?.onProgress?.({ step: BridgeState.SourceLocked, current: 0, total: 1, note: 'building source spend' });

  const lockAmount = BigInt(intent.lockAmount);
  const userLockValue = BigInt(intent.userLockValueWei);
  // Native route (value-bearing userLock): unwrap the unshielded WETH -> native ETH inside the
  // RelayAdapt multicall, then pay userLock with ETH value (no approve). ERC20 route: approve + pull.
  const isNative = userLockValue > 0n;

  const prelude = isNative
    ? {
        to: getAddress(intent.unshieldToken),
        value: 0n,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [lockAmount] }),
      }
    : {
        to: getAddress(intent.unshieldToken),
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [getAddress(intent.srcTrainAddress), lockAmount],
        }),
      };

  const calls = [
    prelude,
    { to: getAddress(intent.srcTrainAddress), value: userLockValue, data: intent.userLockCalldata },
  ];

  const txData: TxData = await args.relayAdaptUnshield({
    unshieldToken: getAddress(intent.unshieldToken),
    grossAmount: BigInt(intent.grossUnshield),
    reshieldTo: args.reshieldTo,
    calls,
  });

  const hash = (await args.broadcaster.sendTransaction(txData)) as Hex;

  await args.srcHost.provider.waitForTransaction(hash);

  // Approximate the source lock timelock for UI/refund timing (the contract enforces the real one).
  const timelock = intent.timelockDelta
    ? (Math.floor(Date.now() / 1000) + Number(intent.timelockDelta)).toString()
    : undefined;

  handle = transition(handle, BridgeState.SourceLocked, { srcTxHash: hash, timelock });
  args.callbacks?.onProgress?.({ step: BridgeState.SourceLocked, current: 1, total: 1, note: hash });

  return commit(handle, ctx);
}
