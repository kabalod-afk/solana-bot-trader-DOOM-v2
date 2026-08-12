import { Connection, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';

export interface WindowSolWatch {
  solAccount: string;
  isTokenAccount: boolean;
}

export interface ObservationResult {
  passed: boolean;
  reason?: string;
  entrySizeSol: number;
  buyVolumeRatio: number;
  observationTimeMs: number;
  txCount: number;
  currentMcUsd?: number;
  trigger?: 'helios' | 'volume_burst' | 'organic_impulse';
}

export interface TxTick {
  timestamp: number;
  amountSol: number;
}

/** Estado de tracking para evaluación dinámica de momentum (ventana 0-45s). */
export interface TokenTrackingState {
  initialMcUsd: number;
  currentMcUsd: number;
  txHistory: TxTick[];
  uniqueWallets: Set<string>;
  buyTimestamps: number[];
}

interface LiveTicks {
  buys: number;
  sells: number;
  hasThirdPartySell: boolean;
  isDevSelling: boolean;
  lpDrained: boolean;
  volumeSolIn: number;
  wallets: string[];
  currentPoolSol: number;
  didRpc: boolean;
}

const WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export class WindowObserver {
  constructor(
    private connection: Connection,
    private helios: HeliosEngine
  ) {}

  /**
   * Momentum desde pesos Helios (JSON): ráfaga de logs, ráfaga SOL, impulso MC.
   */
  public evaluateMomentum(tokenData: TokenTrackingState): boolean {
    const { initialMcUsd, currentMcUsd, txHistory, uniqueWallets, buyTimestamps } =
      tokenData;
    const w = this.helios.weights();
    const now = Date.now();

    const recentBuys = buyTimestamps.filter((t) => now - t <= 15_000).length;
    if (recentBuys >= w.log_burst_buys) {
      console.log(
        `[TRIGGER] Helios JSON: ráfaga de logs ${recentBuys} buys / 15s (umbral ${w.log_burst_buys})`
      );
      return true;
    }

    const recentVolumeSol = txHistory
      .filter((tx) => now - tx.timestamp <= 15_000)
      .reduce((sum, tx) => sum + tx.amountSol, 0);

    if (recentVolumeSol >= w.volume_burst_sol) {
      console.log(
        `[TRIGGER] Helios JSON: ráfaga +${recentVolumeSol.toFixed(2)} SOL en 15s (umbral ${w.volume_burst_sol})`
      );
      return true;
    }

    if (initialMcUsd > 0) {
      const mcMultiplier = currentMcUsd / initialMcUsd;
      if (
        mcMultiplier >= w.organic_mc_multiplier &&
        uniqueWallets.size >= w.min_unique_wallets
      ) {
        console.log(
          `[TRIGGER] Helios JSON: impulso ${mcMultiplier.toFixed(2)}x MC con ${uniqueWallets.size} wallets`
        );
        return true;
      }
    }

    return false;
  }

  async observeWindow(
    poolAddress: string,
    initialPoolSol: number,
    deployerAddress?: string,
    initialMcUsd = 0,
    solWatch?: WindowSolWatch
  ): Promise<ObservationResult> {
    const startTime = Date.now();
    const MAX_WINDOW_MS = 45_000;
    const w = this.helios.weights();
    const minWindowMs = w.min_observation_window_ms;
    const { minTxCount } = loadMomentumConfig(w.min_pool_sol_threshold);
    const highConvictionPool = w.min_pool_sol_threshold * 3;

    let thirdPartySells = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let isLpSecured = true;
    let lastPoolSol = initialPoolSol;

    const tracking: TokenTrackingState = {
      initialMcUsd,
      currentMcUsd: initialMcUsd,
      txHistory: [],
      uniqueWallets: new Set<string>(),
      buyTimestamps: [],
    };

    let pool: PublicKey;
    try {
      pool = new PublicKey(poolAddress);
    } catch {
      return {
        passed: false,
        reason: 'Pool address inválida',
        entrySizeSol: 0,
        buyVolumeRatio: 0,
        observationTimeMs: 0,
        txCount: 0,
      };
    }

    // Sin onLogs (Connection WS): solo HTTP getBalance — evita segundo socket 522 a Helius
    const logBuffer: string[] = [];
    let lastSolRpcAt = 0;

    try {
      while (Date.now() - startTime < MAX_WINDOW_MS) {
        const elapsedPre = Date.now() - startTime;
        // Poll SOL cada 2s tras 3s (sin logs WS)
        const forceRpc =
          elapsedPre >= 3_000 && Date.now() - lastSolRpcAt >= 2_000;
        const ticks = await this.consumeTicks(
          pool,
          logBuffer,
          deployerAddress,
          initialPoolSol,
          lastPoolSol,
          forceRpc,
          solWatch
        );
        if (ticks.didRpc) lastSolRpcAt = Date.now();
        logBuffer.length = 0;

        totalBuys += ticks.buys;
        totalSells += ticks.sells;
        if (ticks.hasThirdPartySell) thirdPartySells++;
        if (ticks.lpDrained) isLpSecured = false;

        if (ticks.volumeSolIn > 0) {
          tracking.txHistory.push({
            timestamp: Date.now(),
            amountSol: ticks.volumeSolIn,
          });
        }
        if (ticks.buys > 0) {
          const nowTs = Date.now();
          for (let i = 0; i < ticks.buys; i++) tracking.buyTimestamps.push(nowTs);
        }
        for (const w of ticks.wallets) {
          if (w !== deployerAddress && w !== poolAddress) {
            tracking.uniqueWallets.add(w);
          }
        }

        lastPoolSol = ticks.currentPoolSol;
        // Proxy MC: escala con SOL en pool (suficiente para detectar impulso en ventana corta)
        if (initialPoolSol > 0 && initialMcUsd > 0) {
          tracking.currentMcUsd =
            initialMcUsd * (ticks.currentPoolSol / initialPoolSol);
        }

        const totalTx = totalBuys + totalSells;
        const buyRatio = totalTx > 0 ? totalBuys / totalTx : 0;
        const elapsedTime = Date.now() - startTime;

        if (ticks.isDevSelling || !isLpSecured) {
          return {
            passed: false,
            reason: 'Dev vendió o retiró LP durante los 45s',
            entrySizeSol: 0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            txCount: totalTx,
            currentMcUsd: tracking.currentMcUsd,
          };
        }

        // Momentum dinámico (ráfaga / impulso) — puede disparar antes del checklist Helios
        if (elapsedTime >= 5_000 && this.evaluateMomentum(tracking)) {
          const isBurst =
            tracking.buyTimestamps.filter((t) => Date.now() - t <= 15_000).length >=
              w.log_burst_buys ||
            tracking.txHistory
              .filter((tx) => Date.now() - tx.timestamp <= 15_000)
              .reduce((s, tx) => s + tx.amountSol, 0) >= w.volume_burst_sol;
          const isHighConviction =
            buyRatio >= Math.max(0.8, w.ideal_buy_ratio) &&
            initialPoolSol >= highConvictionPool;
          return {
            passed: true,
            entrySizeSol: isHighConviction ? 1.5 : 1.0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            txCount: totalTx,
            currentMcUsd: tracking.currentMcUsd,
            trigger: isBurst ? 'volume_burst' : 'organic_impulse',
          };
        }

        const minRatio = w.ideal_buy_ratio;
        if (
          elapsedTime >= minWindowMs &&
          thirdPartySells >= 1 &&
          buyRatio >= minRatio &&
          isLpSecured &&
          totalTx >= minTxCount
        ) {
          const isHighConviction =
            buyRatio >= Math.max(0.8, w.ideal_buy_ratio) &&
            initialPoolSol >= highConvictionPool;
          return {
            passed: true,
            entrySizeSol: isHighConviction ? 1.5 : 1.0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            txCount: totalTx,
            currentMcUsd: tracking.currentMcUsd,
            trigger: 'helios',
          };
        }

        await new Promise((r) => setTimeout(r, 2_000));
      }
    } catch (e) {
      console.error('[WINDOW_ERROR]', e);
    }

    return {
      passed: false,
      reason: 'Tiempo agotado (45s) sin confirmar momentum ni checklist Helios',
      entrySizeSol: 0,
      buyVolumeRatio: 0,
      observationTimeMs: MAX_WINDOW_MS,
      txCount: totalBuys + totalSells,
      currentMcUsd: tracking.currentMcUsd,
    };
  }

  private async consumeTicks(
    pool: PublicKey,
    logBuffer: string[],
    deployerAddress: string | undefined,
    initialPoolSol: number,
    lastPoolSol: number,
    forceRpc: boolean,
    solWatch?: WindowSolWatch
  ): Promise<LiveTicks> {
    let buys = 0;
    let sells = 0;
    let hasThirdPartySell = false;
    let isDevSelling = false;
    const wallets: string[] = [];

    for (const line of logBuffer) {
      const lower = line.toLowerCase();
      const isIxBuy =
        lower.includes('instruction: buy') || lower.includes('instruction:buy');
      const isIxSell =
        lower.includes('instruction: sell') || lower.includes('instruction:sell');

      if (isIxBuy) {
        buys++;
      } else if (isIxSell) {
        sells++;
        hasThirdPartySell = true;
      }

      // Dev sell: solo instrucción Sell explícita + pubkey del deployer (no Transfer de create)
      if (
        deployerAddress &&
        isIxSell &&
        line.includes(deployerAddress)
      ) {
        isDevSelling = true;
      }

      const matches = line.match(WALLET_RE);
      if (matches) {
        for (const m of matches) wallets.push(m);
      }
    }

    // Sin logs nuevos: no gastar getBalance (reusa último SOL conocido)
    if (!forceRpc && buys + sells === 0 && logBuffer.length === 0) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling: false,
        lpDrained: false,
        volumeSolIn: 0,
        wallets,
        currentPoolSol: lastPoolSol,
        didRpc: false,
      };
    }

    const currentPoolSol = await this.readPoolSol(pool, solWatch);
    // Evitar falso LP drain si RPC devolvió 0 por timeout
    const lpDrained =
      initialPoolSol > 0 &&
      currentPoolSol > 0.01 &&
      currentPoolSol < initialPoolSol * 0.9;
    const delta = currentPoolSol - lastPoolSol;
    const volumeSolIn = Math.max(0, delta);

    if (buys + sells === 0 && Math.abs(delta) <= 0.001) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling,
        lpDrained,
        volumeSolIn: 0,
        wallets,
        currentPoolSol,
        didRpc: true,
      };
    }

    // Sin logs WS: inflow = buy, outflow = sell (proxy)
    if (buys + sells === 0) {
      if (delta > 0.001) buys = 1;
      else if (delta < -0.001) {
        sells = 1;
        hasThirdPartySell = true;
      }
    }

    return {
      buys,
      sells,
      hasThirdPartySell,
      isDevSelling,
      lpDrained,
      volumeSolIn,
      wallets,
      currentPoolSol,
      didRpc: true,
    };
  }

  private async readPoolSol(
    pool: PublicKey,
    solWatch?: WindowSolWatch
  ): Promise<number> {
    try {
      if (solWatch?.isTokenAccount) {
        const bal = await this.connection.getTokenAccountBalance(
          new PublicKey(solWatch.solAccount)
        );
        return bal.value.uiAmount ?? 0;
      }
      const target = solWatch?.solAccount
        ? new PublicKey(solWatch.solAccount)
        : pool;
      return (await this.connection.getBalance(target).catch(() => 0)) / 1e9;
    } catch {
      return (await this.connection.getBalance(pool).catch(() => 0)) / 1e9;
    }
  }
}
