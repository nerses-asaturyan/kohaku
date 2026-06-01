import { type Hex, decodeFunctionData, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { TRAIN_ABI } from '../src/abis';
import { type TrainQuote, mapQuoteToUserLock, substituteHashlock } from '../src/quote';

const quote: TrainQuote = {
  signature: '0xabcd',
  receiveAmount: '999',
  sourceSolverAddress: '0x' + '1'.repeat(40),
  destinationSolverAddress: '0x' + '2'.repeat(40),
  quoteExpirationTimestampInSeconds: 2_000_000_000,
  timelockTimeSpanInSeconds: 3600,
  route: {
    source: { network: 'eip155:421614' },
    destination: { network: 'eip155:11155111', tokenSymbol: 'WETH', tokenContract: '0x' + '3'.repeat(40) },
  },
  reward: { amount: '5', rewardTimelockTimeSpanInSeconds: 1800, rewardToken: 'WETH', rewardRecipientAddress: '0x' + '4'.repeat(40) },
};

const hashlock = ('0x' + '7'.repeat(64)) as Hex;
const receiver = getAddress('0x' + '5'.repeat(40));
const sourceToken = getAddress('0x' + '6'.repeat(40));
const refundTo = getAddress('0x' + '8'.repeat(40));

describe('mapQuoteToUserLock', () => {
  it('substitutes the binding hashlock + ShieldedReceiver and maps fields', () => {
    const built = mapQuoteToUserLock({ quote, hashlock, shieldedReceiver: receiver, lockAmount: 1000n, sourceToken, refundTo });

    expect(built.valueWei).toBe(0n);
    expect(built.lockAmount).toBe(1000n);
    expect(built.quoteExpiry).toBe(2_000_000_000n);
    expect(built.timelockDelta).toBe(3600n);

    const decoded = decodeFunctionData({ abi: TRAIN_ABI, data: built.calldata });

    expect(decoded.functionName).toBe('userLock');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [params, dst, userData, solverData] = decoded.args as any;

    expect(params.hashlock).toBe(hashlock);
    expect(params.amount).toBe(1000n);
    expect(getAddress(params.recipient)).toBe(getAddress(quote.sourceSolverAddress));
    expect(getAddress(params.token)).toBe(sourceToken);
    expect(getAddress(params.refundTo)).toBe(refundTo);
    expect(params.srcChain).toBe('eip155:421614');
    expect(getAddress(dst.dstAddress)).toBe(receiver);
    expect(dst.dstAmount).toBe(999n);
    expect(dst.dstChain).toBe('eip155:11155111');
    expect(solverData).toBe('0xabcd');
    expect(userData).not.toBe('0x' + '0'.repeat(64)); // non-zero nonce
  });
});

describe('substituteHashlock', () => {
  it('rewrites only the hashlock + dst address of an existing userLock calldata', () => {
    const built = mapQuoteToUserLock({ quote, hashlock, shieldedReceiver: receiver, lockAmount: 1000n, sourceToken, refundTo });
    const newHashlock = ('0x' + 'a'.repeat(64)) as Hex;
    const newReceiver = getAddress('0x' + 'b'.repeat(40));
    const rebound = substituteHashlock(built.calldata, newHashlock, newReceiver);

    const decoded = decodeFunctionData({ abi: TRAIN_ABI, data: rebound });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [params, dst] = decoded.args as any;

    expect(params.hashlock).toBe(newHashlock);
    expect(getAddress(dst.dstAddress)).toBe(newReceiver);
    expect(params.amount).toBe(1000n); // unchanged
    expect(getAddress(params.recipient)).toBe(getAddress(quote.sourceSolverAddress)); // unchanged
  });
});
