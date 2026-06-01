import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  sha256,
} from 'viem';

import { BINDING_PARAMS, RAILGUN_SHIELD_ABI } from './abis';
import type { ShieldRequestTemplate } from './types';

/** Convert the JSON-safe template to the viem tuple (bigint tokenSubID) used by encoders/contracts. */
export function templateToTuple(t: ShieldRequestTemplate) {
  return {
    npk: t.npk,
    token: {
      tokenType: t.token.tokenType,
      tokenAddress: getAddress(t.token.tokenAddress),
      tokenSubID: BigInt(t.token.tokenSubID),
    },
    encryptedBundle: t.encryptedBundle,
    shieldKey: t.shieldKey,
  } as const;
}

/**
 * Compute the HTLC binding, identical to `ShieldedReceiver.computeBinding`:
 *   secret   = uint256(keccak256(abi.encode(r, dstTrainToken, template)))
 *   hashlock = sha256(abi.encodePacked(secret))   // sha256 over the 32-byte secret
 */
export function computeBinding(
  r: bigint,
  dstTrainToken: Address,
  template: ShieldRequestTemplate,
): { secret: string; hashlock: Hex } {
  const encoded = encodeAbiParameters(BINDING_PARAMS, [r, getAddress(dstTrainToken), templateToTuple(template)]);
  const secretHex = keccak256(encoded); // bytes32

  return {
    secret: BigInt(secretHex).toString(),
    hashlock: sha256(secretHex),
  };
}

/**
 * Recover a `ShieldRequestTemplate` by decoding the calldata returned from
 * `RailgunPlugin.prepareShield({ erc20: WETH })` (a `shield(ShieldRequest[])` call).
 * Uses the first request and drops the `value` field (not part of the template).
 */
export function extractShieldTemplate(shieldCalldata: Hex): ShieldRequestTemplate {
  const { functionName, args } = decodeFunctionData({ abi: RAILGUN_SHIELD_ABI, data: shieldCalldata });

  if (functionName !== 'shield') throw new Error(`expected shield() calldata, got ${functionName}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests = args[0] as readonly any[];

  if (!requests?.length) throw new Error('shield() calldata contained no requests');

  const req = requests[0];

  return {
    npk: req.preimage.npk,
    token: {
      tokenType: Number(req.preimage.token.tokenType),
      tokenAddress: getAddress(req.preimage.token.tokenAddress),
      tokenSubID: req.preimage.token.tokenSubID.toString(),
    },
    encryptedBundle: [
      req.ciphertext.encryptedBundle[0],
      req.ciphertext.encryptedBundle[1],
      req.ciphertext.encryptedBundle[2],
    ],
    shieldKey: req.ciphertext.shieldKey,
  };
}
