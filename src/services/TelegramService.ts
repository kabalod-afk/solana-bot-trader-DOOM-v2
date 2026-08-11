import TelegramBot from 'node-telegram-bot-api';

export class TelegramService {
  private bot: TelegramBot;
  private isPausedFlag = false;
  private onForceCloseCallback?: () => Promise<void>;

  constructor(
    token: string,
    private chatId: string
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.listenCommands();
  }

  public registerForceCloseHandler(handler: () => Promise<void>): void {
    this.onForceCloseCallback = handler;
  }

  /** Escapa caracteres problemáticos fuera de spans `code` y sin romper *bold*. */
  private sanitizeMarkdown(text: string): string {
    const parts = text.split(/(`[^`]*`)/g);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) return part;
        // No escapar * (negrita intencional). Escapar el resto conflictivo.
        return part.replace(/([_[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
      })
      .join('');
  }

  private listenCommands(): void {
    this.bot.on('message', async (msg) => {
      if (msg.chat.id.toString() !== this.chatId || !msg.text) return;
      const text = msg.text.toLowerCase().trim();

      if (
        text.includes('finalizar operacion') ||
        text.includes('orden de finalizar') ||
        text === '/stop'
      ) {
        this.isPausedFlag = true;
        await this.sendText(
          `🛑 *ORDEN RECIBIDA:* Liquidando posiciones activas y pausando el motor...`
        );

        if (this.onForceCloseCallback) {
          await this.onForceCloseCallback();
        }
        await this.sendText(`✅ *POSICIONES LIQUIDADAS Y MOTOR EN PAUSA.*`);
      }

      if (text.includes('reanudar') || text.includes('iniciar operacion')) {
        this.isPausedFlag = false;
        await this.sendText(`🟢 *MOTOR REANUDADO:* Escaneo de nuevos tokens activo.`);
      }

      if (text.includes('estatus') || text.includes('estado')) {
        await this.sendText(
          this.isPausedFlag
            ? `⏸ *ESTADO:* En Pausa.`
            : `🟢 *ESTADO:* Operando activamente.`
        );
      }
    });
  }

  public isPaused(): boolean {
    return this.isPausedFlag;
  }

  public async sendText(msg: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, this.sanitizeMarkdown(msg), {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      // Fallback sin Markdown si el escape falla
      try {
        await this.bot.sendMessage(this.chatId, msg.replace(/[*_`]/g, ''));
      } catch (e2) {
        console.error('[TELEGRAM_ERROR]', e2);
      }
    }
  }

  notifyAnalysis(botId: string, token: string, mcUSD: number, poolSol: number): void {
    void this.sendText(
      `🤖 *[${botId}]* 🔍 *ANALIZANDO TOKEN*\n• Token: \`${token}\`\n• MC Inicial: $${mcUSD.toFixed(0)} USD\n• Pool: ${poolSol} SOL\n⏱ En ventana dinámica 0-45s...`
    );
  }

  notifyStart(
    botId: string,
    opNum: number,
    token: string,
    solInjected: number,
    priceUSD: number
  ): void {
    void this.sendText(
      `🤖 *[${botId}]* 🚀 *OPERACIÓN INICIADA (#${opNum})*\n• Token: \`${token}\`\n• Inversión: ${solInjected.toFixed(2)} SOL (Cartera A)\n• Precio: $${priceUSD.toFixed(8)} USD`
    );
  }

  notifyDerisk(botId: string, solReduced: number, currentExposed: number): void {
    void this.sendText(
      `🤖 *[${botId}]* ⚠️ *DESESCALADA DE RIESGO*\nRetirados: -${solReduced.toFixed(2)} SOL | Expuesto: ${currentExposed.toFixed(2)} SOL`
    );
  }

  notifyBoost(botId: string, solAdded: number, currentExposed: number): void {
    void this.sendText(
      `🤖 *[${botId}]* 🔥 *RE-INYECCIÓN POR RUPTURA*\nAñadidos: +${solAdded.toFixed(2)} SOL | Expuesto: ${currentExposed.toFixed(2)} SOL`
    );
  }

  notifyTakeProfit(
    botId: string,
    multiplier: number,
    amountUSD: number,
    type: string
  ): void {
    void this.sendText(
      `🤖 *[${botId}]* 💰 *TOMA DE COBERTURA (${type})*\nMultiplicador: ${multiplier.toFixed(1)}x | Cobertura Extraída: $${amountUSD} USD`
    );
  }

  notifyStagnantExit(botId: string, token: string): void {
    void this.sendText(
      `🤖 *[${botId}]* 😴 *SALIDA POR ESTANCAMIENTO*\nToken \`${token}\` cerrado tras 4 min sin tendencia.`
    );
  }

  notifySummary(
    botId: string,
    token: string,
    initialSol: number,
    pnlSol: number,
    vaultSol: number
  ): void {
    const emoji = pnlSol >= 0 ? '🟢 GANANCIA' : '🔴 PÉRDIDA';
    void this.sendText(
      `🤖 *[${botId}]* ✅ *RESUMEN DE OPERACIÓN*\n• Token: \`${token}\`\n• Inversión Inicial: ${initialSol.toFixed(2)} SOL\n• PnL Net: ${emoji} ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(2)} SOL\n• Ruteo a Cartera B (Vault): ${vaultSol.toFixed(2)} SOL`
    );
  }
}
