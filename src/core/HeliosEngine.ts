import fs from 'fs';
import path from 'path';

export interface HeliosBrainSchema {
  version: string;
  learned_weights: {
    min_observation_window_ms: number;
    min_pool_sol_threshold: number;
    ideal_buy_ratio: number;
    derisk_sensitivity: number;
  };
  cabal_patterns: {
    blacklisted_funding_wallets: string[];
    suspicious_deployer_signatures: string[];
  };
  performance_metrics: {
    total_trades: number;
    win_rate: number;
    average_pnl_sol: number;
  };
}

export class HeliosEngine {
  private filePath: string;
  public brain: HeliosBrainSchema;

  constructor() {
    this.filePath = path.join(process.cwd(), 'helios_brain.json');
    this.brain = this.loadBrain();
  }

  private loadBrain(): HeliosBrainSchema {
    if (fs.existsSync(this.filePath)) {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as HeliosBrainSchema;
    }
    throw new Error('helios_brain.json no existe.');
  }

  public saveBrain(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.brain, null, 2));
  }

  public isBlacklisted(address: string): boolean {
    return this.brain.cabal_patterns.blacklisted_funding_wallets.includes(address);
  }

  public updateAfterTrade(
    pnlSol: number,
    observationWindowTimeMs: number,
    buyRatio: number,
    wasRug: boolean,
    devAddress?: string
  ): void {
    this.brain.performance_metrics.total_trades++;
    const total = this.brain.performance_metrics.total_trades;
    const isWin = pnlSol > 0;

    const prevWins = (total - 1) * this.brain.performance_metrics.win_rate;
    this.brain.performance_metrics.win_rate = (prevWins + (isWin ? 1 : 0)) / total;

    const prevAvgPnl = this.brain.performance_metrics.average_pnl_sol;
    this.brain.performance_metrics.average_pnl_sol =
      prevAvgPnl + (pnlSol - prevAvgPnl) / total;

    if (wasRug && devAddress && !this.isBlacklisted(devAddress)) {
      this.brain.cabal_patterns.blacklisted_funding_wallets.push(devAddress);
      console.log(`[HELIOS_BRAIN] Dev ${devAddress} añadido a la Blacklist.`);
    }

    if (isWin && observationWindowTimeMs > 0 && observationWindowTimeMs <= 45_000) {
      const currentMin = this.brain.learned_weights.min_observation_window_ms;
      this.brain.learned_weights.min_observation_window_ms = Math.min(
        30_000,
        Math.round(currentMin * 0.8 + observationWindowTimeMs * 0.2)
      );
    }

    if (isWin) {
      this.brain.learned_weights.ideal_buy_ratio = Number(
        (this.brain.learned_weights.ideal_buy_ratio * 0.9 + buyRatio * 0.1).toFixed(2)
      );
    } else {
      this.brain.learned_weights.derisk_sensitivity = Math.min(
        0.5,
        Number((this.brain.learned_weights.derisk_sensitivity + 0.02).toFixed(2))
      );
    }

    this.saveBrain();
  }
}
