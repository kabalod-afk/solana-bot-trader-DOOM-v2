import { JitoExecution } from '../blockchain/JitoExecution';
import { VaultManager } from './VaultManager';
import { TelegramService } from '../services/TelegramService';
import { HeliosEngine } from '../core/HeliosEngine';

export class TradeEngine {
  private previousPeakUSD = 0;
  private highestPriceUSD = 0;
  private entryPriceUSD = 0;
  private currentSolExposed = 0;
  private hasDerisked = false;
  private hasReinjected = false;
  private hasTakenProfit = false;
  private entryTimeMs = Date.now();
  private forceCloseRequested = false;

  constructor(
    private instanceBotId: string,
    private tokenAddress: string,
    private deployerAddress: string,
    private observationTimeMs: number,
    private baseInvestmentSol: number,
    private jito: JitoExecution,
    private vault: VaultManager,
    private telegram: TelegramService,
    private helios: HeliosEngine
  ) {
    this.currentSolExposed = baseInvestmentSol;
  }

  /** Cierre forzado por Telegram — liquidación limpia en el próximo tick. */
  requestForceClose(): void {
    this.forceCloseRequested = true;
  }

  async processTick(metrics: {
    currentPriceUSD: number;
    mcUSD: number;
    buyVolumeRatio: number;
    consecutiveSells: number;
    txPerMinute: number;
    isDevSelling: boolean;
    solPriceUSD?: number;
  }): Promise<'RUNNING' | 'CLOSED'> {
    const solPrice = metrics.solPriceUSD ?? 160;

    if (this.entryPriceUSD === 0) {
      this.entryPriceUSD = metrics.currentPriceUSD;
      this.highestPriceUSD = metrics.currentPriceUSD;
      this.previousPeakUSD = metrics.currentPriceUSD;
    }

    let madeNewAth = false;
    if (metrics.currentPriceUSD > this.highestPriceUSD) {
      this.previousPeakUSD = this.highestPriceUSD;
      this.highestPriceUSD = metrics.currentPriceUSD;
      madeNewAth = true;
    }

    if (this.forceCloseRequested) {
      await this.jito.executeFullSell(this.tokenAddress);
      const pnl =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;
      const vaultSweep = Math.max(0, pnl);
      if (vaultSweep > 0) await this.vault.sweepProfitsToVault(vaultSweep);
      this.helios.updateAfterTrade(
        pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      this.telegram.notifySummary(
        this.instanceBotId,
        this.tokenAddress,
        this.baseInvestmentSol,
        pnl,
        vaultSweep
      );
      return 'CLOSED';
    }

    // 1. RUG PULL
    if (metrics.isDevSelling) {
      await this.jito.executeEmergencyEvacuation(this.tokenAddress);
      void this.telegram.sendText(
        `🚨 *[${this.instanceBotId}] RUG PULL EN MEMPOOL.* Evacuado vía Jito.`
      );

      this.helios.updateAfterTrade(
        -this.currentSolExposed,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        true,
        this.deployerAddress
      );
      this.telegram.notifySummary(
        this.instanceBotId,
        this.tokenAddress,
        this.baseInvestmentSol,
        -this.currentSolExposed,
        0
      );
      return 'CLOSED';
    }

    // 2. TECHO DE MILLONES
    if (metrics.mcUSD >= 8_000_000) {
      await this.jito.executeFullSell(this.tokenAddress);
      const netProfit =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;

      if (netProfit > 0) await this.vault.sweepProfitsToVault(netProfit);
      this.helios.updateAfterTrade(
        netProfit,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      this.telegram.notifySummary(
        this.instanceBotId,
        this.tokenAddress,
        this.baseInvestmentSol,
        netProfit,
        Math.max(0, netProfit)
      );
      return 'CLOSED';
    }

    // 3. TRAILING 30% ATH
    const dropFromPeak =
      (this.highestPriceUSD - metrics.currentPriceUSD) / this.highestPriceUSD;
    if (dropFromPeak >= 0.3) {
      await this.jito.executeFullSell(this.tokenAddress);
      const pnl =
        (metrics.currentPriceUSD / this.entryPriceUSD - 1) * this.currentSolExposed;
      const vaultSweep = Math.max(0, pnl);

      if (vaultSweep > 0) await this.vault.sweepProfitsToVault(vaultSweep);

      this.helios.updateAfterTrade(
        pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      this.telegram.notifySummary(
        this.instanceBotId,
        this.tokenAddress,
        this.baseInvestmentSol,
        pnl,
        vaultSweep
      );
      return 'CLOSED';
    }

    // 4. DESESCALADA
    const deriskSensitivity = this.helios.brain.learned_weights.derisk_sensitivity;
    const isBuyingFatigue =
      metrics.buyVolumeRatio >= 0.4 && metrics.buyVolumeRatio <= 0.48;
    const isConsecutiveSells = metrics.consecutiveSells >= 3;

    if ((isBuyingFatigue || isConsecutiveSells) && !this.hasDerisked) {
      const solToReduce = this.baseInvestmentSol * deriskSensitivity;
      const ok = await this.jito.executePartialSellByRatio(
        this.tokenAddress,
        deriskSensitivity
      );
      if (ok) {
        this.hasDerisked = true;
        this.currentSolExposed -= solToReduce;
        this.telegram.notifyDerisk(
          this.instanceBotId,
          solToReduce,
          this.currentSolExposed
        );
      }
    }

    // 5. RE-INYECCIÓN — solo al marcar un NUEVO ATH por encima de un peak previo > entrada
    const isBreakingPreviousPeak =
      madeNewAth && this.previousPeakUSD > this.entryPriceUSD;

    if (
      isBreakingPreviousPeak &&
      metrics.buyVolumeRatio >= 0.7 &&
      this.hasDerisked &&
      !this.hasReinjected
    ) {
      const boostSol = this.baseInvestmentSol * 0.5;
      const ok = await this.jito.executeBuy(this.tokenAddress, boostSol);
      if (ok) {
        this.hasReinjected = true;
        this.currentSolExposed += boostSol;
        this.telegram.notifyBoost(this.instanceBotId, boostSol, this.currentSolExposed);
      }
    }

    // 6. TP BIFURCADO
    const currentMult = metrics.currentPriceUSD / this.entryPriceUSD;

    if (
      currentMult >= 2.0 &&
      currentMult < 4.0 &&
      metrics.buyVolumeRatio < 0.55 &&
      !this.hasTakenProfit
    ) {
      const ok = await this.jito.executePartialSellByUsd(
        this.tokenAddress,
        80,
        metrics.currentPriceUSD
      );
      if (ok) {
        await this.vault.routeTakeProfitCoverage(80, solPrice);
        this.hasTakenProfit = true;
        this.telegram.notifyTakeProfit(
          this.instanceBotId,
          currentMult,
          80,
          '2x Inestable'
        );
      }
    }

    if (currentMult >= 4.0 && metrics.buyVolumeRatio >= 0.65 && !this.hasTakenProfit) {
      const ok = await this.jito.executePartialSellByUsd(
        this.tokenAddress,
        120,
        metrics.currentPriceUSD
      );
      if (ok) {
        await this.vault.routeTakeProfitCoverage(120, solPrice);
        this.hasTakenProfit = true;
        this.telegram.notifyTakeProfit(
          this.instanceBotId,
          currentMult,
          120,
          '4x Estable (>65% Compras)'
        );
      }
    }

    // 7. MONOTONÍA
    const elapsedTime = Date.now() - this.entryTimeMs;
    const priceVar = Math.abs(currentMult - 1.0);
    if (
      elapsedTime > 240_000 &&
      priceVar < 0.05 &&
      metrics.txPerMinute < 10 &&
      !this.hasTakenProfit
    ) {
      await this.jito.executeFullSell(this.tokenAddress);
      const pnl = (currentMult - 1) * this.currentSolExposed;

      this.helios.updateAfterTrade(
        pnl,
        this.observationTimeMs,
        metrics.buyVolumeRatio,
        false
      );
      this.telegram.notifyStagnantExit(this.instanceBotId, this.tokenAddress);
      this.telegram.notifySummary(
        this.instanceBotId,
        this.tokenAddress,
        this.baseInvestmentSol,
        pnl,
        0
      );
      return 'CLOSED';
    }

    return 'RUNNING';
  }
}
