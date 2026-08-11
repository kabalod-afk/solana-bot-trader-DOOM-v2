import { Connection, PublicKey } from '@solana/web3.js';

export interface RealPoolTick {
  currentPriceUSD: number;
  mcUSD: number;
  currentSolInPool: number;
  tokenReserve: number;
}

const WSOL = 'So11111111111111111111111111111111111111112';

export interface PoolTickOpts {
  coinVault?: string;
  pcVault?: string;
  totalSupplyHint?: number;
}

/**
 * Precio on-chain: prioriza vaults Raydium; fallback balance pool / Jupiter.
 */
export async function fetchRealPoolTick(
  connection: Connection,
  poolAddress: string,
  tokenAddress: string,
  solPriceUSD: number,
  opts?: PoolTickOpts
): Promise<RealPoolTick> {
  const mint = new PublicKey(tokenAddress);
  let currentSolInPool = 0;
  let tokenReserve = 0;

  if (opts?.coinVault && opts?.pcVault) {
    try {
      const coinBal = await connection.getTokenAccountBalance(new PublicKey(opts.coinVault));
      const pcBal = await connection.getTokenAccountBalance(new PublicKey(opts.pcVault));
      const coinInfo = await connection.getParsedAccountInfo(new PublicKey(opts.coinVault));
      const pcInfo = await connection.getParsedAccountInfo(new PublicKey(opts.pcVault));
      const coinMint =
        (coinInfo.value?.data as { parsed?: { info?: { mint?: string } } })?.parsed?.info
          ?.mint ?? '';
      const pcMint =
        (pcInfo.value?.data as { parsed?: { info?: { mint?: string } } })?.parsed?.info
          ?.mint ?? '';

      if (coinMint === WSOL) {
        currentSolInPool = coinBal.value.uiAmount ?? 0;
        tokenReserve = pcBal.value.uiAmount ?? 0;
      } else if (pcMint === WSOL) {
        currentSolInPool = pcBal.value.uiAmount ?? 0;
        tokenReserve = coinBal.value.uiAmount ?? 0;
      } else if (coinMint === tokenAddress) {
        tokenReserve = coinBal.value.uiAmount ?? 0;
        currentSolInPool = pcBal.value.uiAmount ?? 0;
      } else {
        tokenReserve = coinBal.value.uiAmount ?? 0;
        currentSolInPool = pcBal.value.uiAmount ?? 0;
      }
    } catch {
      /* fall through */
    }
  }

  if (currentSolInPool <= 0 || tokenReserve <= 0) {
    const poolPubkey = new PublicKey(poolAddress);
    currentSolInPool = (await connection.getBalance(poolPubkey).catch(() => 0)) / 1e9;
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(poolPubkey, {
        mint,
      });
      tokenReserve =
        tokenAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    } catch {
      tokenReserve = 0;
    }
    if (currentSolInPool < 0.01) {
      try {
        const wsolAccounts = await connection.getParsedTokenAccountsByOwner(poolPubkey, {
          mint: new PublicKey(WSOL),
        });
        const wsolUi =
          wsolAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (wsolUi > currentSolInPool) currentSolInPool = wsolUi;
      } catch {
        /* ignore */
      }
    }
  }

  let totalSupply = opts?.totalSupplyHint ?? 0;
  if (!totalSupply) {
    try {
      const supply = await connection.getTokenSupply(mint);
      totalSupply = supply.value.uiAmount ?? 1_000_000_000;
    } catch {
      totalSupply = 1_000_000_000;
    }
  }

  if (currentSolInPool > 0 && tokenReserve > 0) {
    const currentPriceUSD = (currentSolInPool * solPriceUSD) / tokenReserve;
    return {
      currentPriceUSD,
      mcUSD: currentPriceUSD * totalSupply,
      currentSolInPool,
      tokenReserve,
    };
  }

  try {
    const supplyInfo = await connection.getTokenSupply(mint);
    const decimals = supplyInfo.value.decimals ?? 6;
    const rawAmount = 10 ** decimals;
    const url =
      `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}` +
      `&outputMint=${WSOL}&amount=${rawAmount}&slippageBps=100`;
    const res = await fetch(url);
    if (res.ok) {
      const quote = (await res.json()) as { outAmount?: string };
      const outLamports = Number(quote.outAmount ?? 0);
      const currentPriceUSD = (outLamports / 1e9) * solPriceUSD;
      if (currentPriceUSD > 0) {
        return {
          currentPriceUSD,
          mcUSD: currentPriceUSD * totalSupply,
          currentSolInPool,
          tokenReserve,
        };
      }
    }
  } catch {
    /* ignore */
  }

  return {
    currentPriceUSD: 0,
    mcUSD: 0,
    currentSolInPool,
    tokenReserve,
  };
}
