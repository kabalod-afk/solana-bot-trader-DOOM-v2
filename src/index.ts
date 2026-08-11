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
import { fetchRealPoolTick } from './blockchain/poolTick';
import { loadWalletA } from './core/loadWalletA';

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
  const liveTrading = process.env.LIVE_TRADING === 'true';

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl,
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

  console.log(
    `🔑 Cartera A: ${derivedA} (fuente: ${loaded.source}${loaded.path ? ` ${loaded.path}` : ''})`
  );

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
  let solPriceUSD = 160;
  let lastRejectTelegramMs = 0;

  const refreshSolPrice = async () => {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = (await res.json()) as { solana?: { usd?: number } };
      if (data.solana?.usd) solPriceUSD = data.solana.usd;
    } catch {
      /* keep */
    }
  };
  await refreshSolPrice();
  setInterval(() => void refreshSolPrice(), 60_000);

  telegram.registerForceCloseHandler(async () => {
    const snapshot = [...activeEnginesList];
    for (const item of snapshot) {
      item.engine.requestForceClose();
      const tick = await fetchRealPoolTick(
        connection,
        item.pool,
        item.token,
        solPriceUSD
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

  console.log(`✅ Cartera A: ${walletA.publicKey.toBase58()}`);
  console.log(
    `Helios ${helios.brain.version} | LIVE_TRADING=${liveTrading} | SOL≈$${solPriceUSD}`
  );
  if (!liveTrading) {
    console.log('🧪 DRY-RUN: Helius → B0 (LP burn + sim) → ventana 0-45s; sin compras.');
  }

  await telegram.sendText(
    `🟢 *DOOM v2 ONLINE*\n• Modo: ${liveTrading ? 'LIVE' : 'DRY-RUN'}\n• Feed: Helius WS (parser Raydium/Pump exacto)\n• Cartera A: \`${walletA.publicKey.toBase58()}\``
  );

  /** Procesa un pool en paralelo sin bloquear el WS. */
  const processPoolEvent = async (event: NewPoolEvent): Promise<void> => {
    const token = event.tokenAddress;

    if (telegram.isPaused()) return;
    if (activeTokensSet.has(token) || inflightTokens.has(token)) return;
    // 1. Control de saturación RPC: máx 5 auditorías B0 en paralelo
    if (!scheduler.canAuditInflight()) {
      return;
    }
    if (!scheduler.canSpawnThread()) return;
    if (helios.isBlacklisted(event.deployerAddress)) return;

    inflightTokens.add(token);
    scheduler.registerInflight();

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
        }
      );

      if (!b0Result.passed) {
        console.log(`[B0_REJECT] ${token}: ${b0Result.reason}`);
        const now = Date.now();
        const isFakeMc =
          (b0Result.reason ?? '').includes('Inflado') || b0Result.initialMcUSD > 100_000;
        if (isFakeMc || now - lastRejectTelegramMs > 4000) {
          lastRejectTelegramMs = now;
          await telegram.sendText(
            `🤖 *BLOQUE 0 RECHAZO*\n• Token: \`${token}\`\n• Fuente: ${event.source}\n• Motivo: ${b0Result.reason}` +
              (b0Result.initialMcUSD > 0
                ? `\n• MC: $${b0Result.initialMcUSD.toFixed(0)} | Pool: ${b0Result.initialPoolSol.toFixed(2)} SOL`
                : '')
          );
        }
        return;
      }

      if (!scheduler.canSpawnThread()) return;

      const botInstanceId = scheduler.registerThread();
      activeTokensSet.add(token);

      telegram.notifyAnalysis(
        botInstanceId,
        token,
        b0Result.initialMcUSD,
        b0Result.initialPoolSol
      );

      const obsResult = await observer.observeWindow(
        event.poolAddress,
        b0Result.initialPoolSol,
        event.deployerAddress
      );

      if (!obsResult.passed) {
        await telegram.sendText(
          `🤖 *[${botInstanceId}] RECHAZADO EN VENTANA 0-45s:* ${obsResult.reason}`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const balanceLamports = await connection.getBalance(walletA.publicKey);
      if (balanceLamports / 1e9 < obsResult.entrySizeSol + 0.05) {
        await telegram.sendText(
          `🤖 *[${botInstanceId}] CAPITAL INSUFICIENTE:* ${obsResult.entrySizeSol} SOL + 0.05 gas.`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      if (!liveTrading) {
        await telegram.sendText(
          `🤖 *[${botInstanceId}] DRY-RUN OK:* \`${token.slice(0, 8)}…\` pasó B0+ventana (${obsResult.observationTimeMs}ms, buy=${(obsResult.buyVolumeRatio * 100).toFixed(0)}%). Sin compra.`
        );
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const buyOk = await jito.executeBuy(token, obsResult.entrySizeSol);
      if (!buyOk) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
        return;
      }

      const entryTick = await fetchRealPoolTick(
        connection,
        event.poolAddress,
        token,
        solPriceUSD,
        { coinVault: event.coinVault, pcVault: event.pcVault }
      );
      const entryPrice = entryTick.currentPriceUSD || 0.0001;
      const opNum = opCounter++;

      telegram.notifyStart(botInstanceId, opNum, token, obsResult.entrySizeSol, entryPrice);

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
      };

      const lastBuyRatio = obsResult.buyVolumeRatio;
      const coinVault = event.coinVault;
      const pcVault = event.pcVault;

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
              { coinVault, pcVault }
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
      }, 1000);

      activeEnginesList.push(position);
    } catch (err) {
      console.error(`[ASYNC_SPAWN_ERROR] ${token}:`, err);
      if (activeTokensSet.has(token)) {
        activeTokensSet.delete(token);
        scheduler.releaseThread();
      }
    } finally {
      inflightTokens.delete(token);
      scheduler.releaseInflight();
    }
  };

  const poolListener = new PoolListener(wssUrl, connection, (event: NewPoolEvent) => {
    // Fire-and-forget: no bloquea el WS ni a otros candidatos
    void processPoolEvent(event);
  });
  poolListener.start();

  console.log('📡 PoolListener activo — parser fiduciario Raydium/Pump; cola async sin mutex.');
}

bootstrap().catch((err) => {
  console.error('[DOOM_FATAL]', err);
  process.exit(1);
});
