import { Connection, PublicKey, LogsCallback } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';
import { loadMomentumConfig } from '../core/momentumConfig';

export interface ObservationResult {
  passed: boolean;
  reason?: string;
  entrySizeSol: number;
  buyVolumeRatio: number;
  observationTimeMs: number;
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
}

const WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export class WindowObserver {
  constructor(
    private connection: Connection,
    private helios: HeliosEngine
  ) {}

  /**
   * Evaluación dinámica de momentum (ráfaga 15s / impulso orgánico MC×wallets).
   */
  public evaluateMomentum(tokenData: TokenTrackingState): boolean {
    const { initialMcUsd, currentMcUsd, txHistory, uniqueWallets } = tokenData;
    const now = Date.now();

    // 1. Condición de Ráfaga de Volumen (últimos 15 segundos)
    const recentVolumeSol = txHistory
      .filter((tx) => now - tx.timestamp <= 15_000)
      .reduce((sum, tx) => sum + tx.amountSol, 0);

    if (recentVolumeSol >= 1.5) {
      console.log(
        `[TRIGGER] Ráfaga de volumen detectada: +${recentVolumeSol.toFixed(2)} SOL en 15s`
      );
      return true;
    }

    // 2. Condición por Multiplicador y Compradores Únicos
    if (initialMcUsd > 0) {
      const mcMultiplier = currentMcUsd / initialMcUsd;
      if (mcMultiplier >= 1.8 && uniqueWallets.size >= 5) {
        console.log(
          `[TRIGGER] Impulso orgánico: ${mcMultiplier.toFixed(2)}x MC con ${uniqueWallets.size} wallets`
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
    initialMcUsd = 0
  ): Promise<ObservationResult> {
    const startTime = Date.now();
    const MAX_WINDOW_MS = 45_000;
    const minWindowMs = this.helios.brain.learned_weights.min_observation_window_ms;
    const { minTxCount } = loadMomentumConfig(
      this.helios.brain.learned_weights.min_pool_sol_threshold
    );

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
      };
    }

    const logBuffer: string[] = [];
    const onLogs: LogsCallback = (logs) => {
      if (logs.err) return;
      for (const line of logs.logs) {
        logBuffer.push(line);
      }
    };

    const subId = this.connection.onLogs(pool, onLogs, 'confirmed');

    try {
      while (Date.now() - startTime < MAX_WINDOW_MS) {
        const ticks = await this.consumeTicks(
          pool,
          logBuffer,
          deployerAddress,
          initialPoolSol,
          lastPoolSol
        );
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
          };
        }

        // Momentum dinámico (ráfaga / impulso) — puede disparar antes del checklist Helios
        if (elapsedTime >= 5_000 && this.evaluateMomentum(tracking)) {
          const isBurst =
            tracking.txHistory
              .filter((tx) => Date.now() - tx.timestamp <= 15_000)
              .reduce((s, tx) => s + tx.amountSol, 0) >= 1.5;
          const isHighConviction = buyRatio >= 0.8 && initialPoolSol >= 15.0;
          return {
            passed: true,
            entrySizeSol: isHighConviction ? 1.5 : 1.0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            trigger: isBurst ? 'volume_burst' : 'organic_impulse',
          };
        }

        const minRatio = this.helios.brain.learned_weights.ideal_buy_ratio;
        if (
          elapsedTime >= minWindowMs &&
          thirdPartySells >= 1 &&
          buyRatio >= minRatio &&
          isLpSecured &&
          totalTx >= minTxCount
        ) {
          const isHighConviction = buyRatio >= 0.8 && initialPoolSol >= 15.0;
          return {
            passed: true,
            entrySizeSol: isHighConviction ? 1.5 : 1.0,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
            trigger: 'helios',
          };
        }

        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await this.connection.removeOnLogsListener(subId).catch(() => undefined);
    }

    return {
      passed: false,
      reason: 'Tiempo agotado (45s) sin confirmar momentum ni checklist Helios',
      entrySizeSol: 0,
      buyVolumeRatio: 0,
      observationTimeMs: MAX_WINDOW_MS,
    };
  }

  private async consumeTicks(
    pool: PublicKey,
    logBuffer: string[],
    deployerAddress: string | undefined,
    initialPoolSol: number,
    lastPoolSol: number
  ): Promise<LiveTicks> {
    let buys = 0;
    let sells = 0;
    let hasThirdPartySell = false;
    let isDevSelling = false;
    const wallets: string[] = [];

    for (const line of logBuffer) {
      const lower = line.toLowerCase();
      if (lower.includes('sell') || lower.includes('swap')) {
        if (lower.includes('sell') || lower.includes('amount_in')) {
          sells++;
          hasThirdPartySell = true;
        } else {
          buys++;
        }
      }
      if (deployerAddress && line.includes(deployerAddress)) {
        if (lower.includes('sell') || lower.includes('transfer')) {
          isDevSelling = true;
        }
      }
      const matches = line.match(WALLET_RE);
      if (matches) {
        for (const m of matches) wallets.push(m);
      }
    }

    const currentLamports = await this.connection.getBalance(pool).catch(() => 0);
    const currentPoolSol = currentLamports / 1e9;
    const lpDrained = initialPoolSol > 0 && currentPoolSol < initialPoolSol * 0.9;
    const volumeSolIn = Math.max(0, currentPoolSol - lastPoolSol);

    if (buys + sells === 0 && volumeSolIn <= 0) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling,
        lpDrained,
        volumeSolIn: 0,
        wallets,
        currentPoolSol,
      };
    }

    // Si hay inflow de SOL sin clasificar logs, contar como buy implícito
    if (buys + sells === 0 && volumeSolIn > 0) {
      buys = 1;
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
    };
  }
}
