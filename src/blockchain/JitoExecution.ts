import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { jupiterConfig } from '../core/jupiter';

export interface ExecResult {
  ok: boolean;
  signature: string;
}

const FAIL: ExecResult = { ok: false, signature: '' };

type SwapType = 'BUY' | 'SELL_RATIO' | 'SELL_ALL';

/** Cuentas tip oficiales de Jito mainnet (rotativas). */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkzs47Zvii5cegbn9tZw',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
];

export class JitoExecution {
  private jitoEngineUrl: string;

  constructor(
    private connection: Connection,
    private walletA: Keypair,
    jitoEngineUrl?: string
  ) {
    this.jitoEngineUrl =
      jitoEngineUrl ||
      process.env.JITO_ENGINE_URL ||
      'https://mainnet.block-engine.jito.wtf';
  }

  async executeBuy(tokenAddress: string, amountSol: number): Promise<ExecResult> {
    try {
      console.log(`[JITO_BUY_REAL] Firmando swap ${amountSol} SOL -> ${tokenAddress}`);
      const tx = await this.buildSwapTransaction(tokenAddress, amountSol, 'BUY');
      return await this.sendJitoBundle(tx, 0.005);
    } catch (e) {
      console.error('[JITO_BUY_ERROR] Fallo en compra:', e);
      return FAIL;
    }
  }

  async executePartialSellByUsd(
    tokenAddress: string,
    amountUSD: number,
    currentPriceUSD: number
  ): Promise<ExecResult> {
    if (currentPriceUSD <= 0 || amountUSD <= 0) return FAIL;
    const tokensToSell = amountUSD / currentPriceUSD;
    console.log(
      `[JITO_SELL_USD] Venta parcial $${amountUSD} USD (~${tokensToSell.toFixed(4)} tokens)`
    );

    try {
      const mint = new PublicKey(tokenAddress);
      const parsed = await this.connection.getParsedTokenAccountsByOwner(
        this.walletA.publicKey,
        { mint }
      );
      const uiBal =
        parsed.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
      if (uiBal <= 0) return FAIL;
      const ratio = Math.min(1, Math.max(0, tokensToSell / uiBal));
      return this.executePartialSellByRatio(tokenAddress, ratio);
    } catch (e) {
      console.error('[JITO_SELL_USD] Error resolviendo balance:', e);
      return FAIL;
    }
  }

  async executePartialSellByRatio(tokenAddress: string, ratio: number): Promise<ExecResult> {
    try {
      const safeRatio = Math.min(1, Math.max(0, ratio));
      console.log(
        `[JITO_SELL_RATIO] Vendiendo ${(safeRatio * 100).toFixed(0)}% de ${tokenAddress}`
      );
      const tx = await this.buildSwapTransaction(tokenAddress, safeRatio, 'SELL_RATIO');
      return await this.sendJitoBundle(tx, 0.005);
    } catch (e) {
      console.error('[JITO_SELL_ERROR] Fallo en venta parcial:', e);
      return FAIL;
    }
  }

  async executeFullSell(tokenAddress: string): Promise<ExecResult> {
    try {
      console.log(`[JITO_FULL_SELL] Venta 100% de ${tokenAddress}`);
      const tx = await this.buildSwapTransaction(tokenAddress, 1.0, 'SELL_ALL');
      return await this.sendJitoBundle(tx, 0.01);
    } catch (e) {
      console.error('[JITO_FULL_SELL_ERROR] Fallo en venta total:', e);
      return FAIL;
    }
  }

  async executeEmergencyEvacuation(tokenAddress: string): Promise<ExecResult> {
    try {
      console.log('[JITO_EMERGENCY] EVACUANDO CON PROPINA DE 0.50 SOL...');
      const tx = await this.buildSwapTransaction(tokenAddress, 1.0, 'SELL_ALL');
      return await this.sendJitoBundle(tx, 0.5);
    } catch (e) {
      console.error('[JITO_EMERGENCY_ERROR] Fallo crítico de evacuación:', e);
      return FAIL;
    }
  }

  /**
   * Construye TX versionada. Prioriza Jupiter Swap API si hay red;
   * si falla, aborta (no envía transferencias placeholder a direcciones arbitrarias).
   */
  private async buildSwapTransaction(
    tokenAddress: string,
    amount: number,
    type: SwapType
  ): Promise<VersionedTransaction> {
    const jupiterTx = await this.tryBuildJupiterSwap(tokenAddress, amount, type);
    if (jupiterTx) return jupiterTx;

    throw new Error(
      `[JITO] No se pudo construir swap Jupiter para ${type} ${tokenAddress}. ` +
        'Cablear Raydium SDK o verificar RPC/Jupiter.'
    );
  }

  private async tryBuildJupiterSwap(
    tokenAddress: string,
    amount: number,
    type: SwapType
  ): Promise<VersionedTransaction | null> {
    try {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const isBuy = type === 'BUY';
      const inputMint = isBuy ? SOL_MINT : tokenAddress;
      const outputMint = isBuy ? tokenAddress : SOL_MINT;

      let amountRaw: number;
      if (isBuy) {
        amountRaw = Math.floor(amount * 1e9);
      } else {
        // Para ventas por ratio/all: consultar balance SPL del wallet
        const mint = new PublicKey(tokenAddress);
        const parsed = await this.connection.getParsedTokenAccountsByOwner(
          this.walletA.publicKey,
          { mint }
        );
        const bal =
          parsed.value[0]?.account.data.parsed?.info?.tokenAmount?.amount ?? '0';
        const rawBal = BigInt(bal);
        if (rawBal === 0n) return null;
        const ratio = type === 'SELL_ALL' ? 1 : amount;
        amountRaw = Number((rawBal * BigInt(Math.floor(ratio * 10_000))) / 10_000n);
      }

      if (amountRaw <= 0) return null;

      const { base, headers } = jupiterConfig();
      const quoteUrl =
        `${base}/quote?inputMint=${inputMint}` +
        `&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=300`;

      const quoteRes = await fetch(quoteUrl, { headers });
      if (!quoteRes.ok) return null;
      const quote = await quoteRes.json();

      const swapRes = await fetch(`${base}/swap`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.walletA.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      });
      if (!swapRes.ok) return null;
      const swapJson = (await swapRes.json()) as { swapTransaction?: string };
      if (!swapJson.swapTransaction) return null;

      const tx = VersionedTransaction.deserialize(
        Buffer.from(swapJson.swapTransaction, 'base64')
      );
      tx.sign([this.walletA]);
      return tx;
    } catch (e) {
      console.error('[JITO] Jupiter swap build failed:', e);
      return null;
    }
  }

  private signatureOf(tx: VersionedTransaction): string {
    try {
      const sig = tx.signatures[0];
      if (!sig || sig.every((b) => b === 0)) return '';
      return bs58.encode(sig);
    } catch {
      return '';
    }
  }

  private async sendJitoBundle(tx: VersionedTransaction, tipSol: number): Promise<ExecResult> {
    const tipLamports = Math.floor(tipSol * 1e9);
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );

    const latest = await this.connection.getLatestBlockhash('confirmed');
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.walletA.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    // Re-empaquetar: tip + compute budget junto al swap cuando sea posible.
    // Si la TX Jupiter ya viene compilada, enviamos swap + tip como bundle de 2 txs.
    const tipMessage = new TransactionMessage({
      payerKey: this.walletA.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        tipIx,
      ],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMessage);
    tipTx.sign([this.walletA]);

    const b64Swap = Buffer.from(tx.serialize()).toString('base64');
    const b64Tip = Buffer.from(tipTx.serialize()).toString('base64');

    const response = await fetch(`${this.jitoEngineUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[b64Swap, b64Tip], { encoding: 'base64' }],
      }),
    }).catch((err) => {
      console.error('[JITO_BUNDLE] fetch error:', err);
      return null;
    });

    if (!response) return FAIL;
    const body = (await response.json().catch(() => null)) as {
      result?: string;
      error?: unknown;
    } | null;

    if (!response.ok || !body || body.error || !body.result) {
      console.error('[JITO_BUNDLE] Rejected:', body?.error ?? response.statusText);
      // Fallback: envío directo RPC si el block engine rechaza
      try {
        const sig = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        console.log(`[JITO_FALLBACK_RPC] Enviado: ${sig}`);
        await this.connection.confirmTransaction(
          { signature: sig, ...latest },
          'confirmed'
        );
        return { ok: true, signature: sig };
      } catch (e) {
        console.error('[JITO_FALLBACK_RPC] Fallo:', e);
        return FAIL;
      }
    }

    const swapSig = this.signatureOf(tx);
    console.log(`[JITO_BUNDLE] OK bundleId=${body.result} swap=${swapSig}`);
    return { ok: true, signature: swapSig };
  }
}
