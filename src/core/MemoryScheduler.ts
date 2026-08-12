import os from 'os';

export class MemoryScheduler {
  private activeThreads = 0;
  private nextBotSerial = 1;
  private inflightAudits = 0;
  /** Máx. 1 cadena getTx→B0 a la vez (ahorro Helius). */
  private readonly MAX_INFLIGHT = 1;

  public canSpawnThread(): boolean {
    const freeRamGB = os.freemem() / (1024 * 1024 * 1024);
    // Piso 1: un droplet 1 GB no debe quedar en 0 hilos por RAM fragmentada
    const maxAllowedThreads = Math.max(1, Math.floor(freeRamGB * 2));
    return this.activeThreads < maxAllowedThreads;
  }

  public canAuditInflight(): boolean {
    return this.inflightAudits < this.MAX_INFLIGHT;
  }

  /** Reserva un slot RPC de forma atómica. false = descartar sin gastar RPC. */
  public tryAcquireInflight(): boolean {
    if (this.inflightAudits >= this.MAX_INFLIGHT) return false;
    this.inflightAudits++;
    return true;
  }

  public registerInflight(): void {
    this.inflightAudits++;
  }

  public releaseInflight(): void {
    this.inflightAudits = Math.max(0, this.inflightAudits - 1);
  }

  /** Alias semántico: liberar ranura RPC al cerrar cadena getTx→B0. */
  public releaseRpcSlot(): void {
    this.releaseInflight();
  }

  public getInflightCount(): number {
    return this.inflightAudits;
  }

  /** @deprecated usar getInflightCount */
  public getInflightAudits(): number {
    return this.getInflightCount();
  }

  public registerThread(): string {
    this.activeThreads++;
    const id = `BOT #${String(this.nextBotSerial).padStart(2, '0')}`;
    this.nextBotSerial++;
    return id;
  }

  public releaseThread(): void {
    this.activeThreads = Math.max(0, this.activeThreads - 1);
  }

  public getActiveThreads(): number {
    return this.activeThreads;
  }
}
