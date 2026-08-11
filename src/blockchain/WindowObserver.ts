import { Connection, PublicKey, LogsCallback } from '@solana/web3.js';
import { HeliosEngine } from '../core/HeliosEngine';

export interface ObservationResult {
  passed: boolean;
  reason?: string;
  entrySizeSol: number;
  buyVolumeRatio: number;
  observationTimeMs: number;
}

interface LiveTicks {
  buys: number;
  sells: number;
  hasThirdPartySell: boolean;
  isDevSelling: boolean;
  lpDrained: boolean;
}

export class WindowObserver {
  constructor(
    private connection: Connection,
    private helios: HeliosEngine
  ) {}

  async observeWindow(
    poolAddress: string,
    initialPoolSol: number,
    deployerAddress?: string
  ): Promise<ObservationResult> {
    const startTime = Date.now();
    const MAX_WINDOW_MS = 45_000;
    const minWindowMs = this.helios.brain.learned_weights.min_observation_window_ms;

    let thirdPartySells = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let isLpSecured = true;

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
        const ticks = await this.consumeTicks(pool, logBuffer, deployerAddress, initialPoolSol);
        logBuffer.length = 0;

        totalBuys += ticks.buys;
        totalSells += ticks.sells;
        if (ticks.hasThirdPartySell) thirdPartySells++;
        if (ticks.lpDrained) isLpSecured = false;

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

        const minRatio = this.helios.brain.learned_weights.ideal_buy_ratio;
        if (
          elapsedTime >= minWindowMs &&
          thirdPartySells >= 1 &&
          buyRatio >= minRatio &&
          isLpSecured
        ) {
          const isHighConviction = buyRatio >= 0.8 && initialPoolSol >= 15.0;
          const entrySizeSol = isHighConviction ? 1.5 : 1.0;

          return {
            passed: true,
            entrySizeSol,
            buyVolumeRatio: buyRatio,
            observationTimeMs: elapsedTime,
          };
        }

        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await this.connection.removeOnLogsListener(subId).catch(() => undefined);
    }

    return {
      passed: false,
      reason: 'Tiempo agotado (45s) sin confirmar las 3 condiciones de seguridad',
      entrySizeSol: 0,
      buyVolumeRatio: 0,
      observationTimeMs: MAX_WINDOW_MS,
    };
  }

  private async consumeTicks(
    pool: PublicKey,
    logBuffer: string[],
    deployerAddress: string | undefined,
    initialPoolSol: number
  ): Promise<LiveTicks> {
    let buys = 0;
    let sells = 0;
    let hasThirdPartySell = false;
    let isDevSelling = false;

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
    }

    // Sin inventar buys/sells: si no hay logs, ratio queda en 0 hasta actividad real
    if (buys + sells === 0) {
      return {
        buys: 0,
        sells: 0,
        hasThirdPartySell: false,
        isDevSelling: false,
        lpDrained: false,
      };
    }

    const currentLamports = await this.connection.getBalance(pool).catch(() => 0);
    const currentSol = currentLamports / 1e9;
    const lpDrained = initialPoolSol > 0 && currentSol < initialPoolSol * 0.9;

    return { buys, sells, hasThirdPartySell, isDevSelling, lpDrained };
  }
}
