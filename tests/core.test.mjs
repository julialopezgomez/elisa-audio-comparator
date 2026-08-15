import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeBase64Url, driftExceeds, formatTime, interpolateAlignment, noteSummary, pairedTimes } from '../docs/lib/core.js';

const alignment = JSON.parse(await readFile(new URL('../docs/data/alignment.json', import.meta.url)));

test('formatea tiempos sin redondear hacia delante', () => {
  assert.equal(formatTime(102.9), '01:42');
  assert.equal(formatTime(-1), '00:00');
});

test('decodifica claves base64url de 256 bits', () => {
  assert.equal(decodeBase64Url('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').length, 32);
  assert.throws(() => decodeBase64Url('clave mala'));
});

test('interpola en ambos sentidos solo entre anchors', () => {
  const forward = interpolateAlignment(alignment, '5016', 300);
  assert.equal(forward.available, true);
  const reverse = interpolateAlignment(alignment, '5017', forward.time);
  assert.equal(reverse.available, true);
  assert.ok(Math.abs(reverse.time - 300) < 3, `${reverse.time} no vuelve cerca de 300`);
  assert.equal(interpolateAlignment(alignment, '5016', -1).available, false);
  assert.equal(interpolateAlignment(alignment, '5017', 9999).available, false);
});

test('una nota produce un resumen legible', () => {
  assert.equal(
    noteSummary({ take: '5016', version: 'mejorado', time: 102, otherTake: '5017', equivalentTime: 107, text: 'Respira aquí' }),
    'Toma 5016 · Mejorado · 01:42 · equivalente en 5017: 01:47 — Respira aquí',
  );
});

test('la pareja A/B comparte tiempo lógico y corrige deriva a partir de 35 ms', () => {
  assert.deepEqual(pairedTimes(12, 0.02, { original: 20, mejorado: 20 }), { original: 12, mejorado: 12.02 });
  assert.equal(driftExceeds(12.03, 12), false);
  assert.equal(driftExceeds(12.04, 12), true);
});
