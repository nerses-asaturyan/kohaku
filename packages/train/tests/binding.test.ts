import { type Hex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, sha256 } from 'viem';
import { describe, expect, it } from 'vitest';

import { BINDING_PARAMS, RAILGUN_SHIELD_ABI } from '../src/abis';
import { computeBinding, extractShieldTemplate, templateToTuple } from '../src/binding';
import type { ShieldRequestTemplate } from '../src/types';

const WETH = getAddress('0x980B62Da83eFf3D4576C647993b0c1D7faf17c73');
const b32 = (c: string): Hex => `0x${c.repeat(64)}` as Hex;

const template: ShieldRequestTemplate = {
  npk: b32('1'),
  token: { tokenType: 0, tokenAddress: WETH, tokenSubID: '0' },
  encryptedBundle: [b32('a'), b32('b'), b32('c')],
  shieldKey: b32('d'),
};

describe('computeBinding', () => {
  it('matches the keccak256/sha256 formula and is deterministic', () => {
    const r = 123456789n;
    const a = computeBinding(r, WETH, template);
    const b = computeBinding(r, WETH, template);

    expect(a).toEqual(b);

    const encoded = encodeAbiParameters(BINDING_PARAMS, [r, WETH, templateToTuple(template)]);
    const secretHex = keccak256(encoded);

    expect(a.secret).toBe(BigInt(secretHex).toString());
    expect(a.hashlock).toBe(sha256(secretHex));
  });

  it('changing r, token, or template changes the hashlock', () => {
    const base = computeBinding(1n, WETH, template).hashlock;

    expect(computeBinding(2n, WETH, template).hashlock).not.toBe(base);
    expect(computeBinding(1n, getAddress('0x' + '2'.repeat(40)), template).hashlock).not.toBe(base);
    expect(computeBinding(1n, WETH, { ...template, npk: b32('2') }).hashlock).not.toBe(base);
  });
});

describe('extractShieldTemplate', () => {
  it('decodes the template from shield(ShieldRequest[]) calldata', () => {
    const request = {
      preimage: {
        npk: template.npk,
        token: { tokenType: 0, tokenAddress: WETH, tokenSubID: 0n },
        value: 1n,
      },
      ciphertext: { encryptedBundle: template.encryptedBundle, shieldKey: template.shieldKey },
    };
    const data = encodeFunctionData({ abi: RAILGUN_SHIELD_ABI, functionName: 'shield', args: [[request]] });

    const t = extractShieldTemplate(data);

    expect(t.npk).toBe(template.npk);
    expect(getAddress(t.token.tokenAddress)).toBe(WETH);
    expect(t.token.tokenType).toBe(0);
    expect(t.token.tokenSubID).toBe('0');
    expect(t.encryptedBundle).toEqual(template.encryptedBundle);
    expect(t.shieldKey).toBe(template.shieldKey);
  });

  it('round-trips through computeBinding (extracted template binds identically)', () => {
    const request = {
      preimage: { npk: template.npk, token: { tokenType: 0, tokenAddress: WETH, tokenSubID: 0n }, value: 7n },
      ciphertext: { encryptedBundle: template.encryptedBundle, shieldKey: template.shieldKey },
    };
    const data = encodeFunctionData({ abi: RAILGUN_SHIELD_ABI, functionName: 'shield', args: [[request]] });
    const t = extractShieldTemplate(data);

    expect(computeBinding(42n, WETH, t)).toEqual(computeBinding(42n, WETH, template));
  });
});
