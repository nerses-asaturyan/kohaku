import type { RailgunPlugin } from '@kohaku-eth/railgun';
import { type Address, type Hex, bytesToBigInt, decodeFunctionData, getAddress } from 'viem';

import { TRAIN_ABI } from './abis';
import { computeBinding } from './binding';
import { DEFAULT_DEST_CHAIN_ID, DEFAULT_SOURCE_CHAIN_ID, UINT120_MAX, trainChain } from './config';
import { inverseUnshieldGross } from './fees';
import { buildShieldTemplate } from './railgun';
import { type TrainApi, buildUserLock, loadTrainApi, substituteHashlock } from './quote';
import type { BridgeIntent } from './types';

export type CreateBridgeIntentArgs = {
  /** Destination Railgun plugin (Eth-Sepolia) — used to mint the shield template + recipient 0zk. */
  dstRailgun: RailgunPlugin;
  /** Source WETH lock amount (wei). Required unless `userLockCalldata` is supplied. */
  amount?: bigint;
  /** Refund recipient on the source after the timelock (the user's public address). */
  refundTo: Address;

  srcChainId?: number; // default Arbitrum Sepolia
  dstChainId?: number; // default Ethereum Sepolia

  /** Pre-constructed Station client; else one is loaded from `trainStationUrl`. */
  trainApi?: TrainApi;
  trainStationUrl?: string;

  /** Override token contracts for the quote (default: each chain's WETH). */
  sourceTokenContract?: Address;
  destinationTokenContract?: Address;

  /**
   * Override input mode: a real solver-signed `userLock` calldata to re-bind
   * (only the hashlock + dst address are substituted). Requires `srcTrainAddress`.
   */
  userLockCalldata?: Hex;
  srcTrainAddress?: Address;
};

function randomUint256(): bigint {
  const bytes = new Uint8Array(32);

  globalThis.crypto.getRandomValues(bytes);

  return bytesToBigInt(bytes);
}

function decodeUserLockAmount(calldata: Hex): bigint {
  const decoded = decodeFunctionData({ abi: TRAIN_ABI, data: calldata });

  if (decoded.functionName !== 'userLock') throw new Error('userLockCalldata is not a Train.userLock call');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params = (decoded.args as any)[0];

  return BigInt(params.amount);
}

/**
 * Build the binding (r/secret/hashlock), the destination shield template, and the
 * bound source `userLock` calldata. Does NOT broadcast anything.
 */
export async function createBridgeIntent(args: CreateBridgeIntentArgs): Promise<BridgeIntent> {
  const srcChainId = args.srcChainId ?? DEFAULT_SOURCE_CHAIN_ID;
  const dstChainId = args.dstChainId ?? DEFAULT_DEST_CHAIN_ID;
  const srcChain = trainChain(srcChainId);
  const dstChain = trainChain(dstChainId);

  const shieldedReceiver = dstChain.shieldedReceiver;

  if (!shieldedReceiver) throw new Error(`no ShieldedReceiver configured for dst chain ${dstChainId}`);

  // 1. Destination shield template (+ the dst 0zk recipient) and the HTLC binding.
  const dstWeth = args.destinationTokenContract ?? dstChain.weth;
  const { template, railgunAddress } = await buildShieldTemplate(args.dstRailgun, dstWeth);

  const r = randomUint256();
  const dstTrainToken = getAddress(dstWeth); // WETH-as-ERC20: dst Train lock token == shield token
  const { secret, hashlock } = computeBinding(r, dstTrainToken, template);

  // 2. Source userLock — fetch a fresh quote, or re-bind a supplied calldata.
  const srcWeth = args.sourceTokenContract ?? srcChain.weth;
  let userLockCalldata: Hex;
  let userLockValueWei = 0n;
  let lockAmount: bigint;
  let srcTrainAddress: Address;
  let quoteExpiry: string | undefined;
  let timelockDelta: string | undefined;
  let solverId: string | undefined;

  if (args.userLockCalldata) {
    if (!args.srcTrainAddress) throw new Error('srcTrainAddress is required with userLockCalldata');

    lockAmount = decodeUserLockAmount(args.userLockCalldata);
    userLockCalldata = substituteHashlock(args.userLockCalldata, hashlock, shieldedReceiver);
    srcTrainAddress = getAddress(args.srcTrainAddress);
  } else {
    if (args.amount === undefined) throw new Error('amount is required (or supply userLockCalldata)');

    const api = args.trainApi ?? (await loadTrainApi(args.trainStationUrl));
    const built = await buildUserLock({
      api,
      srcChainId,
      dstChainId,
      amount: args.amount,
      hashlock,
      shieldedReceiver,
      refundTo: getAddress(args.refundTo),
      sourceTokenContract: getAddress(srcWeth),
      destinationTokenContract: dstTrainToken,
    });

    userLockCalldata = built.calldata;
    userLockValueWei = built.valueWei;
    lockAmount = built.lockAmount;
    srcTrainAddress = built.trainAddress;
    quoteExpiry = built.quoteExpiry.toString();
    timelockDelta = built.timelockDelta.toString();
    solverId = built.solverId;
  }

  if (lockAmount > UINT120_MAX) {
    throw new Error(`lock amount ${lockAmount} exceeds uint120 (Railgun shield cap)`);
  }

  const grossUnshield = inverseUnshieldGross(lockAmount);

  return {
    kind: 'erc20',
    createdAt: new Date().toISOString(),
    r: r.toString(),
    secret,
    hashlock,
    template,
    srcChainId,
    dstChainId,
    srcTrainAddress,
    dstTrainToken,
    shieldToken: dstTrainToken,
    shieldedReceiverAddress: shieldedReceiver,
    railgunAddress,
    unshieldToken: getAddress(srcWeth),
    lockAmount: lockAmount.toString(),
    grossUnshield: grossUnshield.toString(),
    userLockCalldata,
    userLockValueWei: userLockValueWei.toString(),
    solverId,
    quoteExpiry,
    timelockDelta,
  };
}
