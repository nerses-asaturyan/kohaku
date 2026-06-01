import { RAILGUN_UNSHIELD_FEE_BPS, UNSHIELD_BUFFER_WEI } from './config';

export function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/**
 * Smallest gross unshield such that `floor(gross * (10000 - feeBps) / 10000) >= net`,
 * plus a small buffer to absorb 1-wei floor-division loss (swept back via the
 * reshield residue). Mirrors the POC's `inverseUnshieldGross`.
 */
export function inverseUnshieldGross(net: bigint, feeBps: bigint = RAILGUN_UNSHIELD_FEE_BPS): bigint {
  let gross = ceilDiv(net * 10_000n, 10_000n - feeBps);

  while ((gross * (10_000n - feeBps)) / 10_000n < net) {
    gross += 1n;
  }

  return gross + UNSHIELD_BUFFER_WEI;
}
