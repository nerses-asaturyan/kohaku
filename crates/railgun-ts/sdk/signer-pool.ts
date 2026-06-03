import type { AssetAmount, ERC20AssetId } from "@kohaku-eth/plugins";
import type { RailgunSigner, AssetId, RailgunProvider } from "./lib";

export interface DrainEntry {
    signer: RailgunSigner;
    asset: AssetId;
    amount: bigint;
}

/**
 * Helper class to manage multiple signers for a single user. Can be be used to 
 * aggregate UTXOs across multiple keys when preparing a transfer or unshield.
 */
export class SignerPool {
    private signers: RailgunSigner[] = [];

    constructor(primary: RailgunSigner) {
        this.signers.push(primary);
    }

    //? Safe to assume at least one signer exists since constructor requires it.
    get primary(): RailgunSigner { return this.signers[0]!; }
    get all(): RailgunSigner[] { return [...this.signers]; }

    add(signer: RailgunSigner) {
        this.signers.push(signer);
    }

    /**
     * Drain UTXOs across all signers to satisfy requested token amounts.
     * Returns a list of (signer, asset, amount) contributions.
     * Throws if any token can't be fully covered.
     */
    async drain(
        provider: RailgunProvider,
        tokens: AssetAmount<ERC20AssetId>[],
    ): Promise<DrainEntry[]> {
        // Mirror balance(): refresh the UTXO indexer + POI provider before reading SPENDABLE notes,
        // otherwise drain can see a stale/POI-filtered view (notes counted by a synced balance()
        // query but not yet spendable here) and throw "Insufficient balance" despite enough funds.
        await provider.sync();

        // Key by LOWERCASED contract: token contracts come in checksummed (getAddress) while
        // provider.balance() returns them lowercased — an exact-case Map.get() misses, so drain
        // would ignore real balances and throw "Insufficient balance" despite having funds.
        const remaining = new Map(tokens.map(t => [t.asset.contract.toLowerCase(), t.amount]));
        const entries: DrainEntry[] = [];

        for (const signer of this.signers) {
            const balances = await provider.balance(signer.address);
            // eslint-disable-next-line no-console
            console.log('[drain] signer', signer.address, 'spendable:',
                balances.map((b: any) => [b[0]?.value ?? b[0]?.type, String(b[1])]),
                '| need:', [...remaining].map(([k, v]) => [k, String(v)]));

            for (const b of balances) {
                const asset = b[0];
                const balance = b[1];
                if (balance <= 0n) continue;
                if (asset.type !== "Erc20") continue;

                const key = String(asset.value).toLowerCase();
                const need = remaining.get(key);
                if (!need || need <= 0n) continue;

                const take = need < balance ? need : balance;
                entries.push({ signer, asset: asset, amount: take });
                remaining.set(key, need - take);
            }
        }

        for (const [asset, amt] of remaining) {
            if (amt > 0n) {
                // eslint-disable-next-line no-console
                console.error('[drain] insufficient for', asset, '— still short', String(amt), 'wei after draining all signers');
                throw new Error(`Insufficient balance for ${asset}`);
            }
        }

        return entries;
    }
}
