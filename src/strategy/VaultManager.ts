import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

export class VaultManager {
  constructor(
    private connection: Connection,
    private walletA: Keypair,
    private walletBPubkey: PublicKey
  ) {}

  /** Cobertura TP: los SOL del swap parcial ya vuelven a Cartera A. */
  async routeTakeProfitCoverage(amountUSD: number, solPriceUSD: number): Promise<boolean> {
    const solToReturn = amountUSD / solPriceUSD;
    console.log(
      `[VAULT_REAL] Re-incorporando $${amountUSD} USD (${solToReturn.toFixed(4)} SOL) a Cartera A (${this.walletA.publicKey.toBase58()}).`
    );
    return true;
  }

  /** lootSweeper: transfiere superávit neto a Cartera B. */
  async sweepProfitsToVault(profitNetSOL: number): Promise<boolean> {
    if (profitNetSOL <= 0) return false;

    try {
      const lamportsToSweep = Math.floor(profitNetSOL * 1e9);
      const balance = await this.connection.getBalance(this.walletA.publicKey);
      const gasReserve = Math.floor(0.05 * 1e9);
      const maxSweep = Math.max(0, balance - gasReserve);
      const lamports = Math.min(lamportsToSweep, maxSweep);

      if (lamports <= 0) {
        console.warn('[VAULT_SWEEPER] Sin saldo transferible tras reserva de gas.');
        return false;
      }

      console.log(
        `[VAULT_SWEEPER_REAL] Transfiriendo +${(lamports / 1e9).toFixed(4)} SOL a Cartera B (${this.walletBPubkey.toBase58()})...`
      );

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletA.publicKey,
          toPubkey: this.walletBPubkey,
          lamports,
        })
      );

      const sig = await sendAndConfirmTransaction(this.connection, tx, [this.walletA], {
        commitment: 'confirmed',
      });
      console.log(`[VAULT_SWEEPER_CONFIRMED] Firma: ${sig}`);
      return true;
    } catch (e) {
      console.error('[VAULT_SWEEPER_ERROR] Error transfiriendo a Vault B:', e);
      return false;
    }
  }
}
