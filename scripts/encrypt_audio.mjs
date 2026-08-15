#!/usr/bin/env node
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const rotate = args.has('--rotate-key');
const baseArg = process.argv.find((value) => value.startsWith('--base-url='));
const baseUrl = baseArg?.slice('--base-url='.length) || 'https://USUARIO.github.io/elisa-audio-comparator/';
const secretsDir = path.join(root, 'secrets');
const assetsDir = path.join(root, 'docs', 'assets');
const keyPath = path.join(secretsDir, 'master-key.base64url');
await mkdir(secretsDir, { recursive: true });
await mkdir(assetsDir, { recursive: true });

const toBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');
let keyBytes;
try {
  keyBytes = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64url');
  if (rotate) keyBytes = randomBytes(32);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  keyBytes = randomBytes(32);
}
if (keyBytes.length !== 32) throw new Error('La clave local no tiene 256 bits');
await writeFile(keyPath, `${toBase64Url(keyBytes)}\n`, { mode: 0o600 });

const analysis = JSON.parse(await readFile(path.join(root, 'build', 'audio-analysis.json'), 'utf8'));
const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
const manifest = { schemaVersion: 1, algorithm: 'AES-256-GCM', takes: {} };

for (const take of ['5016', '5017']) {
  manifest.takes[take] = { versions: {}, abOffset: analysis.takes[take].abOffset };
  for (const version of ['original', 'mejorado']) {
    const name = `IMG_${take}_${version}`;
    const plain = await readFile(path.join(root, 'build', 'audio', `${name}.m4a`));
    const iv = randomBytes(12);
    const encrypted = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const decrypted = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted));
    const before = createHash('sha256').update(plain).digest('hex');
    const after = createHash('sha256').update(decrypted).digest('hex');
    if (before !== after || !plain.equals(decrypted)) throw new Error(`Fallo de verificación byte a byte: ${name}`);
    const outputName = `${name}.m4a.enc`;
    await writeFile(path.join(assetsDir, outputName), encrypted);
    const info = analysis.takes[take].versions[version];
    manifest.takes[take].versions[version] = {
      file: `assets/${outputName}`,
      iv: toBase64Url(iv),
      mime: 'audio/mp4',
      duration: info.duration,
      encryptedBytes: encrypted.length,
      integratedLufs: info.integratedLufs,
      matchGainDb: info.matchGainDb,
    };
    console.log(`OK ${outputName}: ${(encrypted.length / 1024 / 1024).toFixed(2)} MiB; SHA-256 verificado`);
  }
}
await writeFile(path.join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const secretUrl = `${baseUrl.replace(/\/*$/, '/') }#key=${toBase64Url(keyBytes)}`;
await writeFile(path.join(secretsDir, 'elisa-link.txt'), `${secretUrl}\n`, { mode: 0o600 });
console.log('Clave reutilizada/guardada solo en secrets/master-key.base64url');
console.log('Enlace secreto guardado solo en secrets/elisa-link.txt');
