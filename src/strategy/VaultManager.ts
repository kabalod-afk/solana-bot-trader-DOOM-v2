import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { isLiveTrading } from '../core/jupiter';

export class VaultManager {
  constructor(
    private connection: Connection,
    private walletA: Keypair,
    private walletBPubkey: PublicKey
  ) {}

  public walletBBase58(): string {
    return this.walletBPubkey.toBase58();
  }

  /**
   * Cobertura TP: el partial sell ya deja SOL en A (capital de trabajo).
   * No transfiere a B — el superávit neto va a B en sweepProfitsToVault al cerrar.
   */
  async routeTakeProfitCoverage(amountUSD: number, solPriceUSD: number): Promise<boolean> {
    const solToReturn = amountUSD / solPriceUSD;
    console.log(
      `[VAULT] Cobertura TP $${amountUSD} ≈ ${solToReturn.toFixed(4)} SOL queda en Cartera A (${this.walletA.publicKey.toBase58()}). Superávit al cierre → B (${this.walletBPubkey.toBase58()}).`
    );
    return true;
  }

  /**
   * lootSweeper: transfiere PnL neto (lo producido) de A → Cartera B.
   * Devuelve SOL realmente ruteados (0 si dry-run/sin saldo).
   */
  async sweepProfitsToVault(profitNetSOL: number): Promise<number> {
    if (profitNetSOL <= 0) return 0;

    const live = isLiveTrading();
    if (!live) {
      console.log(
        `[VAULT_DRY] +${profitNetSOL.toFixed(4)} SOL → Cartera B (${this.walletBPubkey.toBase58()}) (no enviado, LIVE_TRADING=false)`
      );
      return 0;
    }

    try {
      const lamportsToSweep = Math.floor(profitNetSOL * 1e9);
      const balance = await this.connection.getBalance(this.walletA.publicKey);
      const gasReserve = Math.floor(0.05 * 1e9);
      const maxSweep = Math.max(0, balance - gasReserve);
      const lamports = Math.min(lamportsToSweep, maxSweep);

      if (lamports <= 0) {
        console.warn('[VAULT_SWEEPER] Sin saldo transferible tras reserva de gas.');
        return 0;
      }

      console.log(
        `[VAULT_SWEEPER] Transfiriendo +${(lamports / 1e9).toFixed(4)} SOL a Cartera B (${this.walletBPubkey.toBase58()})...`
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
      return lamports / 1e9;
    } catch (e) {
      console.error('[VAULT_SWEEPER_ERROR] Error transfiriendo a Vault B:', e);
      return 0;
    }
  }
}
