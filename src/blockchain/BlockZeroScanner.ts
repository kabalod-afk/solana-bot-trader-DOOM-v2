import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';
import { getCachedSolPrice } from '../core/solPriceCache';
import { isLiveTrading, jupiterConfig } from '../core/jupiter';

export interface BlockZeroResult {
  passed: boolean;
  reason?: string;
  initialMcUSD: number;
  initialPoolSol: number;
  totalSupply?: number;
}

export interface AuditTokenOpts {
  lpMintAddress?: string;
  source?: 'raydium' | 'pump';
  coinVault?: string;
  pcVault?: string;
  associatedBondingCurve?: string;
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
    // Blacklist solo por rugs confirmados (Helios ya no auto-bloquea en B0)
    if (this.helios.isBlacklisted(deployerAddress)) {
      return {
        passed: false,
        reason: 'Deployer en Blacklist de Helios (rug confirmado)',
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

    const momentum = loadMomentumConfig(
      this.helios.brain.learned_weights.min_pool_sol_threshold
    );
    const minPoolRequired = momentum.minPoolSol;

    // --- SHORT-CIRCUIT: solo balance SOL/WSOL antes de RPC/HTTP pesado ---
    const quickSol = await this.quickSolLiquidityCheck(pool, opts);
    if (quickSol < minPoolRequired) {
      return {
        passed: false,
        reason: `Pool insuficiente (${quickSol.toFixed(2)} SOL < min ${minPoolRequired} SOL)`,
        initialMcUSD: 0,
        initialPoolSol: quickSol,
      };
    }

    // Solo si supera el mínimo: métricas (reusa SOL del quick check)
    const poolMetrics =
      opts?.source === 'pump'
        ? await this.fetchPumpBondingMetrics(
            pool,
            mint,
            opts.associatedBondingCurve,
            quickSol
          )
        : opts?.source === 'raydium' && opts.coinVault && opts.pcVault
          ? await this.fetchRaydiumVaultMetrics(opts.coinVault, opts.pcVault, mint, quickSol)
          : await this.fetchPoolMetricsFallback(pool, mint);

    // Revalidar SOL con lectura completa (puede diferir del quick check)
    if (poolMetrics.solAmount < minPoolRequired) {
      return {
        passed: false,
        reason: `Pool insuficiente (${poolMetrics.solAmount.toFixed(2)} SOL < min ${minPoolRequired} SOL)`,
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

    const solPriceUSD = getCachedSolPrice();
    const initialMcUSD =
      ((poolMetrics.solAmount * solPriceUSD) / poolMetrics.tokenAmount) *
      poolMetrics.totalSupply;

    // Momentum: fuera de rango → consola/PM2 únicamente (sin Telegram)
    if (
      poolMetrics.solAmount < minPoolRequired ||
      initialMcUSD < momentum.minMcUSD ||
      initialMcUSD > momentum.maxMcUSD
    ) {
      return {
        passed: false,
        reason: `Fuera de rango de momentum (${poolMetrics.solAmount.toFixed(2)} SOL, $${initialMcUSD.toFixed(0)} MC; rango $${momentum.minMcUSD}-$${momentum.maxMcUSD}, pool≥${minPoolRequired})`,
        initialMcUSD,
        initialPoolSol: poolMetrics.solAmount,
      };
    }

    let mintSafe = poolMetrics.mintSafe;
    if (mintSafe === undefined) {
      const tokenAccountInfo = await this.connection.getAccountInfo(mint);
      if (!tokenAccountInfo || tokenAccountInfo.data.length < 82) {
        return {
          passed: false,
          reason: 'No se pudo leer la cuenta Mint SPL',
          initialMcUSD,
          initialPoolSol: poolMetrics.solAmount,
        };
      }
      mintSafe =
        tokenAccountInfo.data.readUInt32LE(0) === 0 &&
        tokenAccountInfo.data.readUInt32LE(46) === 0;
    }
    if (!mintSafe) {
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

    const liveTrading = isLiveTrading();

    // Cabal on-chain solo las primeras veces en LIVE (sin lista de firmas sospechosas)
    const mem = this.helios.brain.analysis_memory.deployers[deployerAddress];
    if (liveTrading && (mem?.windowSeen ?? 0) <= 2) {
      if (await this.traceCabalFundingOnChain(deployer)) {
        return {
          passed: false,
          reason: 'Cluster de Cabal/Bundling detectado',
          initialMcUSD,
          initialPoolSol: poolMetrics.solAmount,
        };
      }
    }

    if (liveTrading) {
      const dryRunOk = await this.simulateChainedBuySell(tokenAddress);
      if (!dryRunOk) {
        return {
          passed: false,
          reason: 'Dry-Run fallido (Buy→Sell tax >5% o Honeypot / sin ruta)',
          initialMcUSD,
          initialPoolSol: poolMetrics.solAmount,
        };
      }
    }

    return {
      passed: true,
      initialMcUSD,
      initialPoolSol: poolMetrics.solAmount,
      totalSupply: poolMetrics.totalSupply,
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

  /** Pump: reusa SOL del quick check; 1 getMultipleAccounts (mint + ABC). */
  private async fetchPumpBondingMetrics(
    _bondingCurve: PublicKey,
    mint: PublicKey,
    associatedBondingCurve: string | undefined,
    knownSol: number
  ) {
    const PUMP_SUPPLY = 1_000_000_000;
    let tokenAmount = 0;
    let totalSupply = PUMP_SUPPLY;
    let mintSafe: boolean | undefined;

    const keys: PublicKey[] = [mint];
    if (associatedBondingCurve) {
      keys.push(new PublicKey(associatedBondingCurve));
    }

    try {
      const accs = await this.connection.getMultipleAccountsInfo(keys);
      const mintData = accs[0]?.data;
      if (mintData && mintData.length >= 82) {
        mintSafe =
          mintData.readUInt32LE(0) === 0 && mintData.readUInt32LE(46) === 0;
        const decimals = mintData[44];
        const rawSupply = mintData.readBigUInt64LE(36);
        const ui = Number(rawSupply) / 10 ** decimals;
        if (ui > 0) totalSupply = ui;
      }
      const abc = accs[1];
      if (abc && abc.data.length >= 72) {
        const raw = abc.data.readBigUInt64LE(64);
        const decimals = mintData && mintData.length >= 45 ? mintData[44] : 6;
        tokenAmount = Number(raw) / 10 ** decimals;
      }
    } catch {
      /* keep defaults */
    }

    if (tokenAmount <= 0 && knownSol > 0) {
      tokenAmount = totalSupply;
    }

    return {
      solAmount: knownSol,
      tokenAmount,
      totalSupply: totalSupply > 0 ? totalSupply : Math.max(tokenAmount, 1),
      mintSafe,
    };
  }

  /** Raydium: 1 getMultipleAccounts (vaults + mint). knownSol del quick check. */
  private async fetchRaydiumVaultMetrics(
    coinVaultStr: string,
    pcVaultStr: string,
    mint: PublicKey,
    knownSol: number
  ) {
    try {
      const coinVault = new PublicKey(coinVaultStr);
      const pcVault = new PublicKey(pcVaultStr);
      const accs = await this.connection.getMultipleAccountsInfo([
        coinVault,
        pcVault,
        mint,
      ]);

      const mintData = accs[2]?.data;
      const tokenDecimals = mintData && mintData.length >= 45 ? mintData[44] : 6;
      let totalSupply = 1_000_000_000;
      if (mintData && mintData.length >= 44) {
        const ui = Number(mintData.readBigUInt64LE(36)) / 10 ** tokenDecimals;
        if (ui > 0) totalSupply = ui;
      }

      const coinMint =
        accs[0] && accs[0].data.length >= 32
          ? new PublicKey(accs[0].data.subarray(0, 32)).toBase58()
          : '';
      const pcMint =
        accs[1] && accs[1].data.length >= 32
          ? new PublicKey(accs[1].data.subarray(0, 32)).toBase58()
          : '';

      const coinUi = (decimals: number) =>
        accs[0] && accs[0].data.length >= 72
          ? Number(accs[0].data.readBigUInt64LE(64)) / 10 ** decimals
          : 0;
      const pcUi = (decimals: number) =>
        accs[1] && accs[1].data.length >= 72
          ? Number(accs[1].data.readBigUInt64LE(64)) / 10 ** decimals
          : 0;

      let solAmount = knownSol;
      let tokenAmount = 0;

      if (coinMint === WSOL) {
        solAmount = coinUi(9);
        tokenAmount = pcUi(tokenDecimals);
      } else if (pcMint === WSOL) {
        solAmount = pcUi(9);
        tokenAmount = coinUi(tokenDecimals);
      } else if (coinMint === mint.toBase58()) {
        tokenAmount = coinUi(tokenDecimals);
        solAmount = pcUi(9) || knownSol;
      } else {
        tokenAmount = coinUi(tokenDecimals);
        solAmount = pcUi(9) || knownSol;
      }

      if (solAmount <= 0) solAmount = knownSol;

      let mintSafe: boolean | undefined;
      if (mintData && mintData.length >= 82) {
        mintSafe =
          mintData.readUInt32LE(0) === 0 && mintData.readUInt32LE(46) === 0;
      }

      return {
        solAmount,
        tokenAmount,
        totalSupply: totalSupply > 0 ? totalSupply : Math.max(tokenAmount, 1),
        mintSafe,
      };
    } catch (e) {
      console.error('[RAYDIUM_VAULTS]', e);
      return { solAmount: knownSol, tokenAmount: 0, totalSupply: 1 };
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

    return {
      solAmount: Math.max(solAmount, wsolAmount),
      tokenAmount,
      totalSupply: Math.max(tokenAmount, 1_000_000_000),
      mintSafe: undefined as boolean | undefined,
    };
  }

  /**
   * Dry-run simétrico: quote buy SOL→TOKEN luego sell con outAmount exacto.
   * No requiere balance SPL previo. Rechaza si round-trip loss > 5%.
   */
  private async simulateChainedBuySell(tokenAddress: string): Promise<boolean> {
    try {
      const inputAmountLamports = Math.floor(0.1 * 1e9);
      const { base, headers } = jupiterConfig();

      const buyQuoteRes = await fetch(
        `${base}/quote?inputMint=${WSOL}&outputMint=${tokenAddress}&amount=${inputAmountLamports}&slippageBps=500`,
        { headers }
      );
      if (!buyQuoteRes.ok) return false;
      const buyQuote = (await buyQuoteRes.json()) as {
        outAmount?: string;
        priceImpactPct?: string;
      };
      if (!buyQuote?.outAmount) return false;

      const expectedTokensOut = buyQuote.outAmount;

      const sellQuoteRes = await fetch(
        `${base}/quote?inputMint=${tokenAddress}&outputMint=${WSOL}&amount=${expectedTokensOut}&slippageBps=500`,
        { headers }
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

  private async traceCabalFundingOnChain(deployer: PublicKey): Promise<boolean> {
    const sigs = await this.connection
      .getSignaturesForAddress(deployer, { limit: 8 })
      .catch(() => []);
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    return sigs.filter((s) => (s.blockTime ?? 0) >= twoHoursAgo).length >= 7;
  }
}
