import dotenv from 'dotenv';
dotenv.config();

import { Connection, PublicKey } from '@solana/web3.js';
import { HeliosEngine } from './core/HeliosEngine';
import { MemoryScheduler } from './core/MemoryScheduler';
import { BlockZeroScanner } from './blockchain/BlockZeroScanner';
import { WindowObserver } from './blockchain/WindowObserver';
import { JitoExecution } from './blockchain/JitoExecution';
import { VaultManager } from './strategy/VaultManager';
import { TelegramService } from './services/TelegramService';
import { TradeEngine } from './strategy/TradeEngine';
import { NewPoolEvent, PoolListener } from './blockchain/PoolListener';
import { fetchRealPoolTick, rememberPoolSupply, PoolTickOpts } from './blockchain/poolTick';
import { loadWalletA } from './core/loadWalletA';
import { loadMomentumConfig } from './core/momentumConfig';
import { getCachedSolPrice, refreshSolPrice } from './core/solPriceCache';
import { isLiveTrading } from './core/jupiter';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Falta variable de entorno: ${key}. Copia .env.example a .env y completa los valores.`
    );
  }
  return value;
}

interface ActivePosition {
  engine: TradeEngine;
  token: string;
  pool: string;
  interval: ReturnType<typeof setInterval>;
  tickLock: boolean;
  tickOpts?: PoolTickOpts;
}

async function bootstrap(): Promise<void> {
  console.log('🚀 INICIANDO MOTOR DOOM v2 EN MAINNET...');

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const wssUrl = requireEnv('SOLANA_WSS_URL');
  const walletAPubkeyEnv = requireEnv('WALLETA_PUBKEY');
  const walletBPubkey = new PublicKey(requireEnv('WALLETB_PUBKEY'));
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');
  const jitoUrl = process.env.JITO_ENGINE_URL;
  const liveTrading = isLiveTrading();

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl,
    disableRetryOnRateLimit: true,
  });

  const loaded = loadWalletA();
  const walletA = loaded.keypair;
  const derivedA = walletA.publicKey.toBase58();
  if (derivedA !== walletAPubkeyEnv) {
    throw new Error(
      `WALLETA_PUBKEY no coincide con la keypair cargada.\n` +
        `  .env:     ${walletAPubkeyEnv}\n` +
        `  derivada: ${derivedA}`
    );
  }
  if (derivedA === walletBPubkey.toBase58()) {
    throw new Error('Cartera A y Cartera B no pueden ser la misma dirección.');
  }

  const walletBStr = walletBPubkey.toBase58();
  console.log(
    `🔑 Cartera A (trabajo): ${derivedA} (fuente: ${loaded.source}${loaded.path ? ` ${loaded.path}` : ''})`
  );
  console.log(`🏦 Cartera B (vault):    ${walletBStr}`);

  const helios = new HeliosEngine();
  const scheduler = new MemoryScheduler();
  const scanner = new BlockZeroScanner(connection, helios, walletA);
  const observer = new WindowObserver(connection, helios);
  const jito = new JitoExecution(connection, walletA, jitoUrl);
  const vault = new VaultManager(connection, walletA, walletBPubkey);
  const telegram = new TelegramService(telegramToken, telegramChatId);

  const activeTokensSet = new Set<string>();
  const inflightTokens = new Set<string>();
  const activeEnginesList: ActivePosition[] = [];
  let opCounter = 1;
  await refreshSolPrice(true);
  let solPriceUSD = getCachedSolPrice();
  setInterval(() => {
    void refreshSolPrice().then(() => {
      solPriceUSD = getCachedSolPrice();
    });
  }, 5 * 60_000);

  telegram.registerForceCloseHandler(async () => {
    const snapshot = [...activeEnginesList];
    for (const item of snapshot) {
      item.engine.requestForceClose();
      const tick = await fetchRealPoolTick(
        connection,
        item.pool,
        item.token,
        solPriceUSD,
        item.tickOpts
      ).catch(() => null);
      await item.engine.processTick({
        currentPriceUSD: tick?.currentPriceUSD || 0.0001,
        mcUSD: tick?.mcUSD || 0,
        buyVolumeRatio: 0.5,
        consecutiveSells: 0,
        txPerMinute: 0,
        isDevSelling: false,
        solPriceUSD,
      });
      clearInterval(item.interval);
      activeTokensSet.delete(item.token);
      scheduler.releaseThread();
    }
    activeEnginesList.length = 0;
  });

  const momentum = loadMomentumConfig(helios.brain.learned_weights.min_pool_sol_threshold);
  const hw = helios.weights();
  console.log(
    `Helios ${helios.brain.version} | LIVE_TRADING=${liveTrading} | SOL≈$${solPriceUSD}`
  );
  console.log(
    `Momentum: pool≥${momentum.minPoolSol} SOL | MC $${momentum.minMcUSD}-$${momentum.maxMcUSD} | minTx=${momentum.minTxCount}`
  );
  console.log(
    `Helios JSON: ventana≥${hw.min_observation_window_ms}ms buy≥${hw.ideal_buy_ratio} burstLogs=${hw.log_burst_buys}`
  );

  const flushHelios = () => {
    try {
      helios.saveBrain();
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', () => {
    flushHelios();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushHelios();
    process.exit(0);
  });
  if (!liveTrading) {
    console.log('🧪 DRY-RUN: Helius → B0 (LP burn + sim) → ventana 0-45s; sin compras.');
  }

  await telegram.sendText(
    `🟢 *DOOM v2 ONLINE*\n• Modo: ${liveTrading ? 'LIVE' : 'DRY-RUN'}\n• Feed: Helius WS (parser Raydium/Pump exacto)\n• Cartera A (trabajo): \`${derivedA}\`\n• Cartera B (vault): \`${walletBStr}\``
  );

  /**
   * Cadena getTx→B0 (ranura ya reservada por PoolListener).
   * Al devolver, PoolListener libera el slot; la ventana 0-45s sigue en background.
   */
  const processBlockZeroChain = async (event: NewPoolEvent): Promise<void> => {
    const token = event.tokenAddress;

    if (!event.poolAddress || !event.tokenAddress) return;
    if (telegram.isPaused()) return;
    if (activeTokensSet.has(token) || inflightTokens.has(token)) return;
    if (!scheduler.canSpawnThread()) return;

    helios.noteSeen(event.deployerAddress);

    inflightTokens.add(token);

    try {
      const b0Result = await scanner.auditToken(
        event.tokenAddress,
        event.poolAddress,
        event.deployerAddress,
        {
          lpMintAddress: event.lpMintAddress,
          source: event.source,
          coinVault: event.coinVault,
          pcVault: event.pcVault,
          associatedBondingCurve: event.associatedBondingCurve,
        }
      );

      if (!b0Result.passed) {
        console.log(`[B0_REJECT] ${token}: ${b0Result.reason}`);
        helios.noteReject(event.deployerAddress, b0Result.reason ?? 'B0 reject');
        void telegram.notifyBlockZeroReject(token, b0Result.reason ?? '');
        inflightTokens.delete(token);
        return;
      }

      // Ranura se libera al retornar (PoolListener.finally). Ventana sin ocupar slot RPC.
      void continueAfterBlockZero(event, b0Result);
    } catch (err) {
      console.error(`[B0_CHAIN_ERROR] ${token}:`, err);
      inflightTokens.delete(token);
    }
  };

  const continueAfterBlockZero = async (
    event: NewPoolEvent,
    b0Result: { initialMcUSD: number; initialPoolSol: number; totalSupply?: number }
  ): Promise<void> => {
    const token = event.tokenAddress;

    try {
      if (!scheduler.canSpawnThread()) {
        inflightTokens.delete(token);
        return;
      }

      const botInstanceId = scheduler.registerThread();
      activeTokensSet.add(token);

      telegram.notifyAnalysisPassed(
        botInstanceId,
        token,
        b0Result.initialMcUSD,
        b0Result.initialPoolSol
      );

      const obsResult = await observer.observeWindow(
        event.poolAddress,
        b0Result.initialPoolSol,
        event.deployerAddress,
        b0Result.initialMcUSD,
        {
          solAccount:
            event.source === 'raydium' && event.pcVault
              ? event.pcVault
              : event.poolAddress,
          isTokenAccount: event.source === 'raydium' && !!event.pcVault,
        }
      );

      if (!obsResult.passed) {
        console.log(`[WINDOW_REJECT] ${token}: ${obsResult.reason}`);
        helios.noteWindowOutcome(event.deployerAddress, false, obsResult.reason);
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      if (obsResult.trigger) {
        console.log(
          `[WINDOW_PASS] ${token}: trigger=${obsResult.trigger} t=${obsResult.observationTimeMs}ms`
        );
      }

      if (!liveTrading) {
        await telegram.sendText(
          `🤖 *[${botInstanceId}] DRY-RUN OK:* \`${token.slice(0, 8)}…\` pasó B0+ventana (${obsResult.observationTimeMs}ms, buy=${(obsResult.buyVolumeRatio * 100).toFixed(0)}%). Sin compra.`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const balanceLamports = await connection.getBalance(walletA.publicKey);
      if (balanceLamports / 1e9 < obsResult.entrySizeSol + 0.05) {
        console.log(
          `[CAPITAL] ${botInstanceId}: insuficiente para ${obsResult.entrySizeSol} SOL + gas`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const buy = await jito.executeBuy(token, obsResult.entrySizeSol);
      if (!buy.ok) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      if (b0Result.totalSupply) {
        rememberPoolSupply(event.poolAddress, b0Result.totalSupply);
      }
      const tickOpts: PoolTickOpts = {
        coinVault: event.coinVault,
        pcVault: event.pcVault,
        associatedBondingCurve: event.associatedBondingCurve,
        totalSupplyHint: b0Result.totalSupply,
      };
      const entryTick = await fetchRealPoolTick(
        connection,
        event.poolAddress,
        token,
        solPriceUSD,
        tickOpts
      );
      const entryPrice = entryTick.currentPriceUSD || 0.0001;
      const opNum = opCounter++;

      telegram.notifyStart(botInstanceId, opNum, token, obsResult.entrySizeSol, entryPrice);
      void telegram.notifyBuyExecuted(
        token,
        obsResult.currentMcUsd ?? entryTick.mcUSD,
        obsResult.txCount,
        obsResult.entrySizeSol,
        buy.signature
      );

      const engine = new TradeEngine(
        botInstanceId,
        token,
        event.deployerAddress,
        obsResult.observationTimeMs,
        obsResult.entrySizeSol,
        jito,
        vault,
        telegram,
        helios
      );

      const position: ActivePosition = {
        engine,
        token,
        pool: event.poolAddress,
        interval: null as unknown as ReturnType<typeof setInterval>,
        tickLock: false,
        tickOpts,
      };

      const lastBuyRatio = obsResult.buyVolumeRatio;

      position.interval = setInterval(() => {
        void (async () => {
          if (position.tickLock) return;
          position.tickLock = true;
          try {
            const tick = await fetchRealPoolTick(
              connection,
              event.poolAddress,
              token,
              solPriceUSD,
              tickOpts
            );
            if (tick.currentPriceUSD <= 0) return;

            const status = await engine.processTick({
              currentPriceUSD: tick.currentPriceUSD,
              mcUSD: tick.mcUSD,
              buyVolumeRatio: lastBuyRatio,
              consecutiveSells: 0,
              txPerMinute: 15,
              isDevSelling: false,
              solPriceUSD,
            });

            if (status === 'CLOSED') {
              clearInterval(position.interval);
              activeTokensSet.delete(token);
              scheduler.releaseThread();
              const idx = activeEnginesList.findIndex((e) => e.token === token);
              if (idx !== -1) activeEnginesList.splice(idx, 1);
            }
          } catch (e) {
            console.error('[TICK_ERROR]', e);
          } finally {
            position.tickLock = false;
          }
        })();
      }, 4_000);

      activeEnginesList.push(position);
    } catch (err) {
      console.error(`[ASYNC_SPAWN_ERROR] ${token}:`, err);
      if (activeTokensSet.has(token)) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
      }
    } finally {
      inflightTokens.delete(token);
    }
  };

  const poolListener = new PoolListener(
    wssUrl,
    connection,
    (event: NewPoolEvent) => processBlockZeroChain(event),
    () => scheduler.tryAcquireInflight(),
    () => scheduler.releaseInflight()
  );
  poolListener.start();

  console.log(
    '📡 PoolListener activo — 1 getTx→B0 a la vez; ventana async; ticks 4s.'
  );
}

bootstrap().catch((err) => {
  console.error('[DOOM_FATAL]', err);
  process.exit(1);
});
