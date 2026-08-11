import os from 'os';

export class MemoryScheduler {
  private activeThreads = 0;
  private nextBotSerial = 1;
  private inflightAudits = 0;
  private readonly MAX_INFLIGHT = 5;

  public canSpawnThread(): boolean {
    const freeRamGB = os.freemem() / (1024 * 1024 * 1024);
    const maxAllowedThreads = Math.floor(freeRamGB * 2);
    if (maxAllowedThreads < 1) return false;
    return this.activeThreads < maxAllowedThreads;
  }

  public canAuditInflight(): boolean {
    return this.inflightAudits < this.MAX_INFLIGHT;
  }

  public registerInflight(): void {
    this.inflightAudits++;
  }

  public releaseInflight(): void {
    this.inflightAudits = Math.max(0, this.inflightAudits - 1);
  }

  public getInflightAudits(): number {
    return this.inflightAudits;
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
