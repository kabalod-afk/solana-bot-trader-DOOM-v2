import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export interface LoadedWalletA {
  keypair: Keypair;
  source: 'private_key' | 'mnemonic';
  path?: string;
}

function parsePrivateKeyEnv(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith('[')) {
    const arr = JSON.parse(t) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(`WALLETA_PRIVATE_KEY debe ser array JSON de 64 bytes (len=${arr?.length})`);
    }
    return Uint8Array.from(arr);
  }
  // base58 opcional
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bs58 = require('bs58') as { decode: (s: string) => Uint8Array };
    const decoded = bs58.decode(t);
    if (decoded.length !== 64) {
      throw new Error(`base58 secret length ${decoded.length} (need 64)`);
    }
    return decoded;
  } catch (e) {
    throw new Error(
      `WALLETA_PRIVATE_KEY inválida (usa JSON [64 bytes] o base58). ${(e as Error).message}`
    );
  }
}

function keypairFromMnemonic(
  mnemonic: string,
  expectedPubkey?: string
): { keypair: Keypair; path: string } {
  const phrase = mnemonic.trim().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('MASTER_MNEMONIC inválido (bip39).');
  }

  const seed = bip39.mnemonicToSeedSync(phrase);

  // Explorar cuentas 0..20 en variantes Phantom / CLI
  const paths: string[] = [];
  for (let i = 0; i <= 20; i++) {
    paths.push(`m/44'/501'/${i}'/0'`);
    paths.push(`m/44'/501'/${i}'`);
    paths.push(`m/44'/501'/${i}'/0'/0'`);
  }

  for (const path of paths) {
    try {
      const { key } = derivePath(path, seed.toString('hex'));
      const keypair = Keypair.fromSeed(key.slice(0, 32));
      if (!expectedPubkey || keypair.publicKey.toBase58() === expectedPubkey) {
        return { keypair, path };
      }
    } catch {
      /* path inválido */
    }
  }

  const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
  const fallback = Keypair.fromSeed(key.slice(0, 32));
  throw new Error(
    `MASTER_MNEMONIC no deriva WALLETA_PUBKEY (probado cuentas 0-20).\n` +
      `  esperado: ${expectedPubkey}\n` +
      `  path m/44'/501'/0'/0' → ${fallback.publicKey.toBase58()}\n` +
      `  Verifica que WALLETA_PUBKEY sea la cuenta HD de ese mnemonic.`
  );
}

/**
 * Carga Cartera A:
 * 1) WALLETA_PRIVATE_KEY (JSON 64 / base58) si existe
 * 2) si no, MASTER_MNEMONIC → HD path Solana
 * Siempre valida contra WALLETA_PUBKEY si está definida.
 */
export function loadWalletA(): LoadedWalletA {
  const expectedPubkey = (process.env.WALLETA_PUBKEY || '').trim();
  const privateRaw = (process.env.WALLETA_PRIVATE_KEY || '').trim();
  const mnemonic = (process.env.MASTER_MNEMONIC || '').trim();

  if (privateRaw) {
    const secret = parsePrivateKeyEnv(privateRaw);
    const keypair = Keypair.fromSecretKey(secret);
    if (expectedPubkey && keypair.publicKey.toBase58() !== expectedPubkey) {
      throw new Error(
        `WALLETA_PUBKEY no coincide con WALLETA_PRIVATE_KEY.\n` +
          `  .env:     ${expectedPubkey}\n` +
          `  derivada: ${keypair.publicKey.toBase58()}`
      );
    }
    return { keypair, source: 'private_key' };
  }

  if (mnemonic) {
    if (!expectedPubkey) {
      throw new Error('Con MASTER_MNEMONIC debes definir WALLETA_PUBKEY para validar la derivación.');
    }
    const { keypair, path } = keypairFromMnemonic(mnemonic, expectedPubkey);
    return { keypair, source: 'mnemonic', path };
  }

  throw new Error(
    'Falta WALLETA_PRIVATE_KEY o MASTER_MNEMONIC. Configura uno de los dos en .env.'
  );
}
