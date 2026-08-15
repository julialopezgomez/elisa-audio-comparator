import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyBytes = Buffer.from((await readFile(path.join(root, 'secrets/master-key.base64url'), 'utf8')).trim(), 'base64url');
const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
const wrongKey = await webcrypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['decrypt']);
const manifest = JSON.parse(await readFile(path.join(root, 'docs/assets/manifest.json'), 'utf8'));

test('clave correcta recupera los cuatro M4A byte por byte', async () => {
  for (const take of ['5016', '5017']) {
    for (const version of ['original', 'mejorado']) {
      const meta = manifest.takes[take].versions[version];
      const encrypted = await readFile(path.join(root, 'docs', meta.file));
      const iv = Buffer.from(meta.iv, 'base64url');
      const decrypted = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted));
      const original = await readFile(path.join(root, 'build/audio', `IMG_${take}_${version}.m4a`));
      assert.equal(createHash('sha256').update(decrypted).digest('hex'), createHash('sha256').update(original).digest('hex'));
      assert.deepEqual(decrypted, original);
    }
  }
});

test('clave incorrecta es rechazada por autenticación GCM', async () => {
  const meta = manifest.takes['5016'].versions.original;
  const encrypted = await readFile(path.join(root, 'docs', meta.file));
  await assert.rejects(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(meta.iv, 'base64url') }, wrongKey, encrypted));
});
