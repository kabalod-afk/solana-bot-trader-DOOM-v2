import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';

export interface BlockZeroResult {
  passed: boolean;
  reason?: string;
  initialMcUSD: number;
  initialPoolSol: number;
}

export interface AuditTokenOpts {
  lpMintAddress?: string;
  source?: 'raydium' | 'pump';
  coinVault?: string;
  pcVault?: string;
}

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SYSTEM_NULL = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';

export class BlockZeroScanner {
  constructor(
    private connection: Connection,
    private helios: HeliosEngine,
    private simWallet?: Keypair
  ) {}

  async auditToken(
    tokenAddress: string,
    poolAddress: string,
    deployerAddress: string,
    opts?: AuditTokenOpts
  ): Promise<BlockZeroResult> {
    if (this.helios.isBlacklisted(deployerAddress)) {
      return {
        passed: false,
        reason: 'Deployer en Blacklist de Helios',
        initialMcUSD: 0,
        initialPoolSol: 0,
      };
    }

    let mint: PublicKey;
    let pool: PublicKey;
    let deployer: PublicKey;
    try {
      mint = new PublicKey(tokenAddress);
      pool = new PublicKey(poolAddress);
      deployer = new PublicKey(deployerAddress);
    } catch {
      return {
        passed: false,
        reason: 'Dirección token/pool/deployer inválida',
        initialMcUSD: 0,
        initialPoolSol: 0,
      };
    }

    const minPoolRequired = this.helios.brain.learned_weights.min_pool_sol_threshold;

    // --- SHORT-CIRCUIT: solo balance SOL/WSOL antes de RPC/HTTP pesado ---
    const quickSol = await this.quickSolLiquidityCheck(pool, opts);
    if (quickSol < minPoolRequired) {
      return {
        passed: false,
        reason: `Pool insuficiente (${quickSol.toFixed(2)} SOL < min Helios ${minPoolRequired} SOL)`,
        initialMcUSD: 0,
        initialPoolSol: quickSol,
      };
    }

    // Solo si supera el mínimo Helios: métricas completas + filtros + Jupiter
    const poolMetrics =
      opts?.source === 'raydium' && opts.coinVault && opts.pcVault
        ? await this.fetchRaydiumVaultMetrics(opts.coinVault, opts.pcVault, mint)
        : await this.fetchPoolMetricsFallback(pool, mint);

    // Revalidar SOL con lectura completa (puede diferir del quick check)
    if (poolMetrics.solAmount < minPoolRequired) {
      return {
        passed: false,
        reason: `Pool insuficiente (${poolMetrics.solAmount.toFixed(2)} SOL < min Helios ${minPoolRequired} SOL)`,
        initialMcUSD: 0,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    if (poolMetrics.tokenAmount <= 0) {
      return {
        passed: false,
        reason: 'No se pudieron leer reservas de token del vault',
        initialMcUSD: 0,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    const solPriceUSD = await this.getRealSolPriceUSD();
    const initialMcUSD =
      ((poolMetrics.solAmount * solPriceUSD) / poolMetrics.tokenAmount) *
      poolMetrics.totalSupply;

    if (initialMcUSD > 100_000) {
      return {
        passed: false,
        reason: `MC Inicial Inflado ($${initialMcUSD.toFixed(0)} > $100k)`,
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    const tokenAccountInfo = await this.connection.getAccountInfo(mint);
    if (!tokenAccountInfo || tokenAccountInfo.data.length < 82) {
      return {
        passed: false,
        reason: 'No se pudo leer la cuenta Mint SPL',
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    const data = tokenAccountInfo.data;
    if (data.readUInt32LE(0) !== 0 || data.readUInt32LE(46) !== 0) {
      return {
        passed: false,
        reason: 'Contrato Inseguro (Mint/Freeze Authority activa)',
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    let lpOk = false;
    if (opts?.source === 'pump') {
      lpOk = poolMetrics.solAmount >= minPoolRequired;
    } else if (opts?.lpMintAddress) {
      lpOk = await this.verifyLpBurnReal(opts.lpMintAddress);
    }

    if (!lpOk) {
      return {
        passed: false,
        reason: 'LP no 100% quemado / no verificable',
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    if (await this.traceCabalFundingOnChain(deployer)) {
      return {
        passed: false,
        reason: 'Cluster de Cabal/Bundling detectado',
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    // Jupiter chained quote solo tras pasar liquidez + seguridad on-chain
    const dryRunOk = await this.simulateChainedBuySell(tokenAddress);
    if (!dryRunOk) {
      return {
        passed: false,
        reason: 'Dry-Run fallido (Buy→Sell tax >5% o Honeypot / sin ruta)',
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    return {
      passed: true,
      initialMcUSD,
      initialPoolSol: poolMetrics.solAmount,
    };
  }

  /**
   * Lectura mínima de liquidez SOL/WSOL (1 RPC) para descartar antes de Jupiter/metadatos.
   */
  private async quickSolLiquidityCheck(
    pool: PublicKey,
    opts?: AuditTokenOpts
  ): Promise<number> {
    // Raydium: vault PC (WSOL) — 1 sola getTokenAccountBalance
    if (opts?.pcVault) {
      const pcBalance = await this.connection
        .getTokenAccountBalance(new PublicKey(opts.pcVault))
        .catch(() => null);
      const fromPc = pcBalance?.value.uiAmount ?? 0;
      if (fromPc > 0) return fromPc;

      // Si pcVault no era WSOL, probar coinVault
      if (opts.coinVault) {
        const coinBalance = await this.connection
          .getTokenAccountBalance(new PublicKey(opts.coinVault))
          .catch(() => null);
        return coinBalance?.value.uiAmount ?? 0;
      }
      return 0;
    }

    // Pump / fallback: lamports nativos en bonding curve / pool
    const lamports = await this.connection.getBalance(pool).catch(() => 0);
    return lamports / 1e9;
  }

  /** Lee balances reales de vaults Raydium (no del AMM id). */
  private async fetchRaydiumVaultMetrics(
    coinVaultStr: string,
    pcVaultStr: string,
    mint: PublicKey
  ) {
    try {
      const coinVault = new PublicKey(coinVaultStr);
      const pcVault = new PublicKey(pcVaultStr);

      const coinBalance = await this.connection.getTokenAccountBalance(coinVault);
      const pcBalance = await this.connection.getTokenAccountBalance(pcVault);

      const coinMint = coinBalance.value.uiAmount;
      const pcAmount = pcBalance.value.uiAmount;

      // Determinar cuál vault es WSOL vs token del proyecto
      const coinInfo = await this.connection.getParsedAccountInfo(coinVault);
      const pcInfo = await this.connection.getParsedAccountInfo(pcVault);
      const coinMintStr =
        (coinInfo.value?.data as { parsed?: { info?: { mint?: string } } })?.parsed?.info
          ?.mint ?? '';
      const pcMintStr =
        (pcInfo.value?.data as { parsed?: { info?: { mint?: string } } })?.parsed?.info
          ?.mint ?? '';

      let solAmount = 0;
      let tokenAmount = 0;

      if (coinMintStr === WSOL) {
        solAmount = coinMint ?? 0;
        tokenAmount = pcAmount ?? 0;
      } else if (pcMintStr === WSOL) {
        solAmount = pcAmount ?? 0;
        tokenAmount = coinMint ?? 0;
      } else if (coinMintStr === mint.toBase58()) {
        tokenAmount = coinMint ?? 0;
        solAmount = pcAmount ?? 0;
      } else {
        tokenAmount = coinMint ?? 0;
        solAmount = pcAmount ?? 0;
      }

      let totalSupply = 0;
      try {
        const supply = await this.connection.getTokenSupply(mint);
        totalSupply = supply.value.uiAmount ?? 0;
      } catch {
        totalSupply = 0;
      }

      return {
        solAmount,
        tokenAmount,
        totalSupply: totalSupply > 0 ? totalSupply : Math.max(tokenAmount, 1),
      };
    } catch (e) {
      console.error('[RAYDIUM_VAULTS]', e);
      return { solAmount: 0, tokenAmount: 0, totalSupply: 1 };
    }
  }

  private async fetchPoolMetricsFallback(pool: PublicKey, mint: PublicKey) {
    const solAmount = (await this.connection.getBalance(pool).catch(() => 0)) / 1e9;
    let tokenAmount = 0;
    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pool, {
        mint,
      });
      tokenAmount =
        tokenAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    } catch {
      tokenAmount = 0;
    }

    let wsolAmount = 0;
    try {
      const wsolAccounts = await this.connection.getParsedTokenAccountsByOwner(pool, {
        mint: new PublicKey(WSOL),
      });
      wsolAmount =
        wsolAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    } catch {
      wsolAmount = 0;
    }

    let totalSupply = 0;
    try {
      const supply = await this.connection.getTokenSupply(mint);
      totalSupply = supply.value.uiAmount ?? 0;
    } catch {
      totalSupply = 0;
    }

    return {
      solAmount: Math.max(solAmount, wsolAmount),
      tokenAmount,
      totalSupply: totalSupply > 0 ? totalSupply : Math.max(tokenAmount, 1),
    };
  }

  /**
   * Dry-run simétrico: quote buy SOL→TOKEN luego sell con outAmount exacto.
   * No requiere balance SPL previo. Rechaza si round-trip loss > 5%.
   */
  private async simulateChainedBuySell(tokenAddress: string): Promise<boolean> {
    try {
      const inputAmountLamports = Math.floor(0.1 * 1e9);

      const buyQuoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL}&outputMint=${tokenAddress}&amount=${inputAmountLamports}&slippageBps=500`
      );
      if (!buyQuoteRes.ok) return false;
      const buyQuote = (await buyQuoteRes.json()) as {
        outAmount?: string;
        priceImpactPct?: string;
      };
      if (!buyQuote?.outAmount) return false;

      const expectedTokensOut = buyQuote.outAmount;

      const sellQuoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=${WSOL}&amount=${expectedTokensOut}&slippageBps=500`
      );
      if (!sellQuoteRes.ok) return false;
      const sellQuote = (await sellQuoteRes.json()) as {
        outAmount?: string;
        priceImpactPct?: string;
      };
      if (!sellQuote?.outAmount) return false;

      const returnedLamports = Number(sellQuote.outAmount);
      if (!Number.isFinite(returnedLamports) || returnedLamports <= 0) return false;

      const totalLossPct =
        (inputAmountLamports - returnedLamports) / inputAmountLamports;

      if (totalLossPct > 0.05) {
        console.log(
          `[DRY_RUN_REJECT] Round-trip loss ${(totalLossPct * 100).toFixed(2)}% > 5%`
        );
        return false;
      }

      return true;
    } catch (e) {
      console.error('[DRY_RUN_CHAINED]', e);
      return false;
    }
  }

  private async verifyLpBurnReal(lpMintAddress: string): Promise<boolean> {
    try {
      const lpMintPubkey = new PublicKey(lpMintAddress);
      const supplyInfo = await this.connection.getTokenSupply(lpMintPubkey);
      if ((supplyInfo.value.uiAmount ?? 0) === 0) return true;

      const largestHolders = await this.connection.getTokenLargestAccounts(lpMintPubkey);
      const burnAddresses = new Set([INCINERATOR, SYSTEM_NULL]);

      const burned = largestHolders.value.every(
        (holder) =>
          (holder.uiAmount ?? 0) === 0 || burnAddresses.has(holder.address.toBase58())
      );
      if (burned) return true;

      const total = supplyInfo.value.uiAmount ?? 0;
      if (total <= 0) return true;
      let burnedAmt = 0;
      for (const h of largestHolders.value) {
        if (burnAddresses.has(h.address.toBase58())) burnedAmt += h.uiAmount ?? 0;
      }
      return burnedAmt / total >= 0.99;
    } catch (e) {
      console.error(`[LP_BURN_CHECK_ERROR] ${lpMintAddress}:`, e);
      return false;
    }
  }

  private async getRealSolPriceUSD(): Promise<number> {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = (await res.json()) as { solana?: { usd?: number } };
      return data.solana?.usd || 160.0;
    } catch {
      return 160.0;
    }
  }

  private async traceCabalFundingOnChain(deployer: PublicKey): Promise<boolean> {
    const sigs = await this.connection
      .getSignaturesForAddress(deployer, { limit: 25 })
      .catch(() => []);
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    return sigs.filter((s) => (s.blockTime ?? 0) >= twoHoursAgo).length >= 20;
  }
}
