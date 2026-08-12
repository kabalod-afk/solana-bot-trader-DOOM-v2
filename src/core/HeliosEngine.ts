import fs from 'fs';
import path from 'path';

export interface HeliosLearnedWeights {
  min_observation_window_ms: number;
  min_pool_sol_threshold: number;
  ideal_buy_ratio: number;
  derisk_sensitivity: number;
  /** SOL de inflow en 15s para trigger ráfaga (si hay muestra on-chain). */
  volume_burst_sol: number;
  /** Compras en logs (15s) para ráfaga sin gastar getBalance. */
  log_burst_buys: number;
  organic_mc_multiplier: number;
  min_unique_wallets: number;
  /** Creates del mismo deployer en 2h → cabal local (sin getSignatures). */
  serial_deploys_per_2h: number;
  /** Rechazos B0/ventana antes de saltar RPC en el siguiente create. */
  skip_after_rejects: number;
}

export interface DeployerMemory {
  seen: number;
  rejects: number;
  lastReason: string;
  lastTs: number;
  windowStart: number;
  windowSeen: number;
}

export interface HeliosBrainSchema {
  version: string;
  learned_weights: HeliosLearnedWeights;
  cabal_patterns: {
    blacklisted_funding_wallets: string[];
    suspicious_deployer_signatures: string[];
  };
  performance_metrics: {
    total_trades: number;
    win_rate: number;
    average_pnl_sol: number;
  };
  analysis_memory: {
    deployers: Record<string, DeployerMemory>;
  };
}

const DEFAULT_WEIGHTS: HeliosLearnedWeights = {
  min_observation_window_ms: 10_000,
  min_pool_sol_threshold: 5.0,
  ideal_buy_ratio: 0.6,
  derisk_sensitivity: 0.3,
  volume_burst_sol: 1.5,
  log_burst_buys: 8,
  organic_mc_multiplier: 1.8,
  min_unique_wallets: 5,
  serial_deploys_per_2h: 8,
  skip_after_rejects: 4,
};

const TWO_HOURS_MS = 2 * 3600 * 1000;
const MAX_DEPLOYERS = 500;

export class HeliosEngine {
  private filePath: string;
  public brain: HeliosBrainSchema;
  private pendingNotes = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.filePath = path.join(process.cwd(), 'helios_brain.json');
    const purged = this.purgeAutoListsOnDisk();
    this.brain = this.loadBrain();
    if (purged) this.saveBrain();
  }

  /**
   * Limpia listas auto-hinchadas (sospechosos + blacklist de rejects B0).
   * Blacklist real solo se vuelve a llenar con rugs confirmados.
   */
  private purgeAutoListsOnDisk(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as HeliosBrainSchema;
      const sus = raw.cabal_patterns?.suspicious_deployer_signatures;
      const bl = raw.cabal_patterns?.blacklisted_funding_wallets;
      let changed = false;
      if (Array.isArray(sus) && sus.length > 0) {
        raw.cabal_patterns.suspicious_deployer_signatures = [];
        changed = true;
      }
      if (Array.isArray(bl) && bl.length > 0) {
        raw.cabal_patterns.blacklisted_funding_wallets = [];
        changed = true;
        console.log(
          `[HELIOS_JSON] Blacklist auto-limpiada (${bl.length} entries). Solo rugs confirmados volverán a entrar.`
        );
      }
      if (changed) {
        fs.writeFileSync(this.filePath, JSON.stringify(raw, null, 2));
      }
      return changed;
    } catch {
      return false;
    }
  }

  private loadBrain(): HeliosBrainSchema {
    if (!fs.existsSync(this.filePath)) {
      throw new Error('helios_brain.json no existe.');
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<HeliosBrainSchema>;
    return {
      version: raw.version ?? '2.1.0-helios',
      learned_weights: { ...DEFAULT_WEIGHTS, ...raw.learned_weights },
      cabal_patterns: {
        blacklisted_funding_wallets: raw.cabal_patterns?.blacklisted_funding_wallets ?? [],
        suspicious_deployer_signatures: [],
      },
      performance_metrics: {
        total_trades: raw.performance_metrics?.total_trades ?? 0,
        win_rate: raw.performance_metrics?.win_rate ?? 0,
        average_pnl_sol: raw.performance_metrics?.average_pnl_sol ?? 0,
      },
      analysis_memory: {
        deployers: raw.analysis_memory?.deployers ?? {},
      },
    };
  }

  public saveBrain(): void {
    this.pendingNotes = 0;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.brain, null, 2));
  }

  private scheduleSave(): void {
    this.pendingNotes++;
    if (this.pendingNotes >= 20) {
      this.saveBrain();
      return;
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.saveBrain(), 10_000);
    }
  }

  public weights(): HeliosLearnedWeights {
    return this.brain.learned_weights;
  }

  public isBlacklisted(address: string): boolean {
    return this.brain.cabal_patterns.blacklisted_funding_wallets.includes(address);
  }

  /** Skip pre-B0 desactivado: pool/MC/mint/ventana bastan. */
  public shouldSkipAnalysis(_deployer: string): { skip: boolean; reason: string } | null {
    return null;
  }

  public isSerialCabal(deployer: string): boolean {
    const mem = this.brain.analysis_memory.deployers[deployer];
    if (!mem) return false;
    this.touchWindow(mem);
    return mem.windowSeen >= this.weights().serial_deploys_per_2h;
  }

  public noteSeen(deployer: string): void {
    if (!deployer) return;
    const mem = this.ensureDeployer(deployer);
    mem.seen++;
    mem.lastTs = Date.now();
    this.touchWindow(mem);
    mem.windowSeen++;
    this.pruneDeployers();
    this.scheduleSave();
  }

  /**
   * Memoria de rejects sin auto-blacklist (B0 ya filtra pool/MC/mint).
   * Blacklist solo vía updateAfterTrade(wasRug=true).
   */
  public noteReject(deployer: string, reason: string): void {
    if (!deployer) return;
    const mem = this.ensureDeployer(deployer);
    mem.rejects++;
    mem.lastReason = reason.slice(0, 120);
    mem.lastTs = Date.now();
    this.scheduleSave();
  }

  public noteWindowOutcome(deployer: string, passed: boolean, reason?: string): void {
    if (!deployer) return;
    if (!passed && reason) this.noteReject(deployer, `ventana: ${reason}`);
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

    const w = this.brain.learned_weights;
    if (isWin && observationWindowTimeMs > 0 && observationWindowTimeMs <= 45_000) {
      w.min_observation_window_ms = Math.min(
        30_000,
        Math.round(w.min_observation_window_ms * 0.8 + observationWindowTimeMs * 0.2)
      );
    }

    if (isWin) {
      w.ideal_buy_ratio = Number((w.ideal_buy_ratio * 0.9 + buyRatio * 0.1).toFixed(2));
    } else {
      w.derisk_sensitivity = Math.min(
        0.5,
        Number((w.derisk_sensitivity + 0.02).toFixed(2))
      );
    }

    this.saveBrain();
  }

  private ensureDeployer(address: string): DeployerMemory {
    const map = this.brain.analysis_memory.deployers;
    if (!map[address]) {
      const now = Date.now();
      map[address] = {
        seen: 0,
        rejects: 0,
        lastReason: '',
        lastTs: now,
        windowStart: now,
        windowSeen: 0,
      };
    }
    return map[address];
  }

  private touchWindow(mem: DeployerMemory): void {
    const now = Date.now();
    if (now - mem.windowStart > TWO_HOURS_MS) {
      mem.windowStart = now;
      mem.windowSeen = 0;
    }
  }

  private pruneDeployers(): void {
    const map = this.brain.analysis_memory.deployers;
    const keys = Object.keys(map);
    if (keys.length <= MAX_DEPLOYERS) return;
    keys
      .sort((a, b) => map[a].lastTs - map[b].lastTs)
      .slice(0, keys.length - MAX_DEPLOYERS + 50)
      .forEach((k) => delete map[k]);
  }

  private pruneLists(): void {
    const cabal = this.brain.cabal_patterns;
    cabal.suspicious_deployer_signatures = [];
    if (cabal.blacklisted_funding_wallets.length > 400) {
      cabal.blacklisted_funding_wallets = cabal.blacklisted_funding_wallets.slice(-300);
    }
  }
}
