/**
 * TRAIN Station quote -> on-chain `Train.userLock` calldata, bound to a
 * shielded-redeem template. Ported from the POC's `scripts/xchain/quote.ts`,
 * generalized to the WETH/ERC20 path and the Arb-Sepolia -> Eth-Sepolia direction.
 *
 * A real solver only fills a `userLock` whose fields match a quote it signed
 * (carried via `solverData`/`userData`); `Train.sol` validates none on-chain. So
 * we fetch a fresh Station quote and substitute ONLY the binding hashlock and the
 * destination address (the ShieldedReceiver) — exactly as the POC does.
 */

import { type Address, type Hex, decodeFunctionData, encodeFunctionData, getAddress, numberToHex } from 'viem';

import { TRAIN_ABI } from './abis';
import { type TrainApi, type TrainQuote, solverLabel } from './train-api';

// Re-export the Station surface so consumers can import it all from `./quote`.
export {
  type TrainApi,
  type TrainNetwork,
  type TrainQuote,
  type QuoteRequest,
  type SolverQuote,
  type AggregatedQuoteResponse,
  loadTrainApi,
  solverLabel,
} from './train-api';

function asUint(value: string, label: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label}="${value}" is not an integer (smallest-unit) string`);
  }
}

export type UserLockMappingArgs = {
  quote: TrainQuote;
  /** Binding hashlock to substitute for the quote's own (so the payout can be shielded). */
  hashlock: Hex;
  /** Destination address the solver must lock to == the ShieldedReceiver. */
  shieldedReceiver: Address;
  /** Source lock amount (WETH wei). */
  lockAmount: bigint;
  /** Source token locked into TRAIN (WETH on the source); 0x0 only for the native parity path. */
  sourceToken: Address;
  /** Address that receives a refund after the timelock (the user's public/refund address). */
  refundTo: Address;
  /** True when the TRAIN route token is native ETH → userLock is value-bearing (no approve). */
  isNativeSource?: boolean;
};

export type BuiltUserLock = {
  calldata: Hex;
  valueWei: bigint;
  lockAmount: bigint;
  quoteExpiry: bigint;
  timelockDelta: bigint;
  dstToken: Address;
  solverId?: string;
  quote: TrainQuote;
};

/**
 * Pure mapping: TRAIN quote -> `userLock` calldata. Mirrors `@train-protocol/evm`'s
 * mapping; substitutes the binding hashlock and the ShieldedReceiver dst address.
 * `value` is 0 on the WETH/ERC20 path (TRAIN pulls via transferFrom after approve).
 */
export function mapQuoteToUserLock(args: UserLockMappingArgs): BuiltUserLock {
  const { quote: q, hashlock, shieldedReceiver, lockAmount, sourceToken, refundTo } = args;

  // NOTE: viem types uint48 fields (timelockDelta/rewardTimelockDelta/quoteExpiry) as `number`,
  // and uint256 fields (amount/rewardAmount) as `bigint`.
  const params = {
    hashlock,
    amount: lockAmount,
    rewardAmount: asUint(q.reward.amount, 'reward.amount'),
    timelockDelta: q.timelockTimeSpanInSeconds,
    rewardTimelockDelta: q.reward.rewardTimelockTimeSpanInSeconds,
    quoteExpiry: q.quoteExpirationTimestampInSeconds,
    refundTo,
    recipient: getAddress(q.sourceSolverAddress), // the solver redeems the source lock
    token: sourceToken,
    rewardToken: q.reward.rewardToken,
    rewardRecipient: q.reward.rewardRecipientAddress,
    srcChain: q.route.source.network,
  } as const;

  const dst = {
    dstChain: q.route.destination.network,
    dstAddress: shieldedReceiver,
    dstAmount: asUint(q.receiveAmount, 'receiveAmount'),
    dstToken: q.route.destination.tokenContract,
  } as const;

  // userData = 32-byte non-zero nonce (a zero nonce is rejected by solvers).
  const userData = numberToHex(BigInt(Date.now()), { size: 32 });
  const solverData = (q.signature.startsWith('0x') ? q.signature : `0x${q.signature}`) as Hex;

  const calldata = encodeFunctionData({
    abi: TRAIN_ABI,
    functionName: 'userLock',
    args: [params, dst, userData, solverData],
  });

  return {
    calldata,
    // Native route: TRAIN.userLock is value-bearing (paid in native ETH, no approve/transferFrom).
    // ERC20 route: value 0 (TRAIN pulls via transferFrom after approve).
    valueWei: args.isNativeSource ? lockAmount : 0n,
    lockAmount,
    quoteExpiry: BigInt(params.quoteExpiry),
    timelockDelta: BigInt(params.timelockDelta),
    dstToken: getAddress(q.route.destination.tokenContract),
    quote: q,
  };
}

export type FetchUserLockArgs = {
  api: TrainApi;
  srcChainId: number;
  dstChainId: number;
  amount: bigint; // source lock amount (WETH wei)
  hashlock: Hex;
  shieldedReceiver: Address;
  refundTo: Address;
  /** Override token contracts (default: each network's WETH/native from /networks). */
  sourceTokenContract?: Address;
  destinationTokenContract?: Address;
};

/** Fetch a fresh quote and build the bound `userLock` calldata + the source TRAIN address. */
export async function buildUserLock(
  args: FetchUserLockArgs,
): Promise<BuiltUserLock & { trainAddress: Address; sourceToken: Address }> {
  const networks = await args.api.getNetworks();
  const src = networks.find((n) => Number(n.chainId) === args.srcChainId);
  const dst = networks.find((n) => Number(n.chainId) === args.dstChainId);

  if (!src) throw new Error(`source chain ${args.srcChainId} not in Station /networks`);

  if (!dst) throw new Error(`destination chain ${args.dstChainId} not in Station /networks`);

  const sourceTokenContract = args.sourceTokenContract ?? src.nativeTokenAddress;
  const destinationTokenContract = args.destinationTokenContract ?? dst.nativeTokenAddress;

  const agg = await args.api.getQuote({
    amount: args.amount.toString(),
    sourceNetwork: src.caip2Id,
    sourceTokenContract,
    destinationNetwork: dst.caip2Id,
    destinationTokenContract,
    includeReward: true,
  });

  if (!agg?.quotes?.length) throw new Error(`no quotes returned (errors=${JSON.stringify(agg?.errors)})`);

  const chosen = agg.quotes.find((q) => q.isBest && q.quote) ?? agg.quotes.find((q) => q.quote);

  if (!chosen?.quote) throw new Error(`no priced quote in response: ${JSON.stringify(agg)}`);

  const built = mapQuoteToUserLock({
    quote: chosen.quote,
    hashlock: args.hashlock,
    shieldedReceiver: args.shieldedReceiver,
    lockAmount: args.amount,
    sourceToken: getAddress(sourceTokenContract),
    refundTo: args.refundTo,
    isNativeSource: getAddress(sourceTokenContract) === getAddress(src.nativeTokenAddress),
  });

  return {
    ...built,
    solverId: solverLabel(chosen),
    trainAddress: getAddress(src.trainContract),
    sourceToken: getAddress(sourceTokenContract),
  };
}

/**
 * Override input mode: take an existing `userLock` calldata (e.g. a real solver-signed
 * UI tx) and substitute ONLY the binding hashlock + the ShieldedReceiver dst address.
 */
export function substituteHashlock(calldata: Hex, hashlock: Hex, shieldedReceiver: Address): Hex {
  const decoded = decodeFunctionData({ abi: TRAIN_ABI, data: calldata });

  if (decoded.functionName !== 'userLock') throw new Error(`not a userLock call: ${decoded.functionName}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [params, dst, userData, solverData] = decoded.args as any;

  return encodeFunctionData({
    abi: TRAIN_ABI,
    functionName: 'userLock',
    args: [{ ...params, hashlock }, { ...dst, dstAddress: shieldedReceiver }, userData, solverData],
  });
}
