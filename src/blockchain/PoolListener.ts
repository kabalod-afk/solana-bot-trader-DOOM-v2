import WebSocket from 'ws';
import {
  Connection,
  PublicKey,
  VersionedMessage,
  Message,
} from '@solana/web3.js';

/** Raydium AMM V4 (mainnet) */
export const RAYDIUM_LIQUIDITY_PROGRAM_V4 =
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/** Pump.fun program (mainnet) */
export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface NewPoolEvent {
  tokenAddress: string;
  poolAddress: string;
  deployerAddress: string;
  lpMintAddress?: string;
  /** Raydium pool coin vault (token) */
  coinVault?: string;
  /** Raydium pool pc vault (WSOL) */
  pcVault?: string;
  /** Pump.fun associated bonding curve (token vault ATA) */
  associatedBondingCurve?: string;
  signature: string;
  timestamp: number;
  source: 'raydium' | 'pump';
}

/** Pump.fee / protocol accounts that must never be treated as mint/pool */
const PUMP_FEE_RECIPIENT = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';


type LogsNotification = {
  params?: {
    result?: {
      value?: {
        signature?: string;
        err?: unknown;
        logs?: string[];
      };
    };
  };
};

/**
 * Raydium V4 `initialize2` — índices de la instrucción:
 * 4 = amm/pool, 7 = lp mint, 8/9 = mints, 10/11 = vaults (fallback 5/6), 17 = creator
 */
export function parseRaydiumInitialize2(
  ixAccounts: PublicKey[],
  signature: string
): NewPoolEvent | null {
  if (ixAccounts.length < 18) return null;

  const poolAddress = ixAccounts[4].toBase58();
  const lpMintAddress = ixAccounts[7].toBase58();
  const mintA = ixAccounts[8].toBase58();
  const mintB = ixAccounts[9].toBase58();
  const deployerAddress = ixAccounts[17].toBase58();

  // Vaults: layout oficial suele ser 10/11; algunos builds usan 5/6
  const coinVault = (ixAccounts[10] ?? ixAccounts[5])?.toBase58();
  const pcVault = (ixAccounts[11] ?? ixAccounts[6])?.toBase58();

  const tokenAddress = mintA === WSOL_MINT ? mintB : mintA;
  if (tokenAddress === WSOL_MINT) return null;

  // Si mintA es WSOL, coin/pc pueden estar invertidos respecto al token del proyecto
  const tokenIsMintA = mintA !== WSOL_MINT;
  const resolvedCoinVault = tokenIsMintA ? coinVault : pcVault;
  const resolvedPcVault = tokenIsMintA ? pcVault : coinVault;

  return {
    tokenAddress,
    poolAddress,
    deployerAddress,
    lpMintAddress,
    coinVault: resolvedCoinVault,
    pcVault: resolvedPcVault,
    signature,
    timestamp: Date.now(),
    source: 'raydium',
  };
}

/**
 * Pump.fun `create`:
 * 0 = mint, 2 = bonding_curve, 3 = associated_bonding_curve, 7 = user
 */
export function parsePumpFunCreate(
  ixAccounts: PublicKey[],
  signature: string
): NewPoolEvent | null {
  if (ixAccounts.length < 8) return null;

  const tokenAddress = ixAccounts[0].toBase58();
  const poolAddress = ixAccounts[2].toBase58();
  const associatedBondingCurve = ixAccounts[3]?.toBase58();
  const deployerAddress = ixAccounts[7].toBase58();

  // Rechazar extracciones basura (fee account, WSOL, etc.)
  if (tokenAddress === WSOL_MINT || poolAddress === WSOL_MINT) return null;
  if (tokenAddress === PUMP_FEE_RECIPIENT || poolAddress === PUMP_FEE_RECIPIENT) return null;
  if (tokenAddress === poolAddress) return null;
  if (tokenAddress === deployerAddress) return null;

  return {
    tokenAddress,
    poolAddress,
    deployerAddress,
    associatedBondingCurve,
    signature,
    timestamp: Date.now(),
    source: 'pump',
  };
}

/** Extrae account keys incluyendo Address Lookup Tables (ALT). */
export function extractAccountKeysFromTx(tx: {
  transaction: { message: Message | VersionedMessage };
  meta?: {
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] };
  } | null;
}): PublicKey[] {
  const message = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;

  if ('getAccountKeys' in message && typeof message.getAccountKeys === 'function') {
    try {
      const keys = message.getAccountKeys(
        loaded
          ? { accountKeysFromLookups: loaded }
          : undefined
      );
      const out: PublicKey[] = [...keys.staticAccountKeys];
      if (loaded) {
        out.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
      } else if (keys.accountKeysFromLookups) {
        out.push(
          ...(keys.accountKeysFromLookups.writable ?? []),
          ...(keys.accountKeysFromLookups.readonly ?? [])
        );
      }
      // Dedup by base58
      const seen = new Set<string>();
      return out.filter((k) => {
        const s = k.toBase58();
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
    } catch {
      /* fall through */
    }
  }

  if ('accountKeys' in message) {
    return (message as Message).accountKeys;
  }
  return [];
}

export class PoolListener {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private seenSignatures = new Set<string>();
  private subId = 1;

  constructor(
    private wssUrl: string,
    private connection: Connection,
    private onNewPoolCallback: (event: NewPoolEvent) => void | Promise<void>,
    /** false → descarta antes de getTransaction (máx. concurrencia RPC). */
    private tryAcquireRpc?: () => boolean,
    private releaseRpc?: () => void
  ) {}

  public start(): void {
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
    }

    this.ws = new WebSocket(this.wssUrl);

    this.ws.on('open', () => {
      console.log(
        '📡 [HELIUS_WS] Conectado — Raydium initialize2 + Pump create (ALT-aware).'
      );
      this.subscribeToProgramLogs();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      void this.handleIncomingLog(data.toString());
    });

    this.ws.on('error', (err) => {
      console.error('❌ [HELIUS_WS_ERROR]', err.message);
    });

    this.ws.on('close', () => {
      if (this.stopped) return;
      console.log('⚠️ [HELIUS_WS] Cerrado. Reconectando en 3s...');
      this.reconnectTimer = setTimeout(() => this.start(), 3000);
    });
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private subscribeToProgramLogs(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const programId of [RAYDIUM_LIQUIDITY_PROGRAM_V4, PUMP_FUN_PROGRAM]) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: this.subId++,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'processed' }],
        })
      );
    }
  }

  private async handleIncomingLog(rawMessage: string): Promise<void> {
    try {
      const parsed = JSON.parse(rawMessage) as LogsNotification;
      const value = parsed.params?.result?.value;
      // 1. Descarte instantáneo si el evento no trae info útil
      if (!value || value.err || !value.signature) return;

      const logs = value.logs ?? [];
      const signature = value.signature;
      if (this.seenSignatures.has(signature)) return;

      const isRaydiumInit = logs.some(
        (l) =>
          l.includes('initialize2') ||
          l.includes('Initialize2') ||
          l.includes('instruction: Initialize2')
      );

      const isPumpCreate = logs.some(
        (l) =>
          l.includes('Instruction: Create') ||
          l.includes('Program log: Instruction: Create')
      );

      if (!isRaydiumInit && !isPumpCreate) return;

      // Solo marcar visto si se adquirió la ranura RPC (si no, un reintento WS puede reprocesar)
      if (this.tryAcquireRpc && !this.tryAcquireRpc()) {
        return;
      }

      this.seenSignatures.add(signature);
      if (this.seenSignatures.size > 5_000) {
        const first = this.seenSignatures.values().next().value;
        if (first) this.seenSignatures.delete(first);
      }

      // Misma ranura para getTx → B0; liberar SOLO al concluir esa cadena
      try {
        const event = await this.resolvePoolFromSignature(
          signature,
          isRaydiumInit ? 'raydium' : 'pump'
        );

        if (!event?.poolAddress || !event.tokenAddress) return;

        console.log(
          `[HELIUS_WS] ${event.source} token=${event.tokenAddress} pool=${event.poolAddress}`
        );

        // Await B0 (no la ventana 0-45s) — el callback debe devolver tras auditToken
        await this.onNewPoolCallback(event);
      } finally {
        this.releaseRpc?.();
      }
    } catch {
      /* heartbeats / JSON basura */
    }
  }

  private async resolvePoolFromSignature(
    signature: string,
    preferred: 'raydium' | 'pump'
  ): Promise<NewPoolEvent | null> {
    const fetchTx = () =>
      this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

    try {
      let tx = await fetchTx();
      // processed WS vs confirmed getTx: 1 reintento corto si aún no indexó
      if (!tx?.transaction) {
        await new Promise((r) => setTimeout(r, 400));
        tx = await fetchTx();
      }
      if (!tx?.transaction) return null;
      return this.extractEventFromTx(tx, signature, preferred);
    } catch (e) {
      console.error('[HELIUS_WS] resolvePoolFromSignature:', e);
      return null;
    }
  }

  private extractEventFromTx(
    tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
    signature: string,
    preferred: 'raydium' | 'pump'
  ): NewPoolEvent | null {
    const accountKeys = extractAccountKeysFromTx(tx);
    if (accountKeys.length === 0) return null;

    const message = tx.transaction.message;
    const raydiumPk = new PublicKey(RAYDIUM_LIQUIDITY_PROGRAM_V4);
    const pumpPk = new PublicKey(PUMP_FUN_PROGRAM);
    const instructions = this.getCompiledInstructions(message);

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId) continue;

      const ixAccounts = ix.accountKeyIndexes
        .map((i) => accountKeys[i])
        .filter((k): k is PublicKey => !!k);

      if (programId.equals(raydiumPk)) {
        const parsed = parseRaydiumInitialize2(ixAccounts, signature);
        if (parsed) return parsed;
      }

      if (programId.equals(pumpPk)) {
        // Solo instrucciones create con suficientes cuentas (evitar buy/sell/other)
        if (ixAccounts.length >= 8) {
          const parsed = parsePumpFunCreate(ixAccounts, signature);
          if (parsed) return parsed;
        }
      }
    }

    // Sin fallback sobre accountKeys globales (desalineaba índices → WSOL/fee como "mint")
    return null;
  }

  private getCompiledInstructions(
    message: Message | VersionedMessage
  ): Array<{ programIdIndex: number; accountKeyIndexes: number[] }> {
    if ('compiledInstructions' in message) {
      return message.compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: [...ix.accountKeyIndexes],
      }));
    }
    if ('instructions' in message) {
      return (message as Message).instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: [...ix.accounts],
      }));
    }
    return [];
  }
}
