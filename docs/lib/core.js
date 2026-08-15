export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

export function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) throw new Error('Formato de clave no válido');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function interpolateAlignment(alignment, fromTake, time, minimumConfidence = 0.38) {
  const from = fromTake === '5016' ? 't5016' : 't5017';
  const to = fromTake === '5016' ? 't5017' : 't5016';
  const anchors = alignment?.anchors || [];
  if (anchors.length < 2 || time < anchors[0][from] || time > anchors.at(-1)[from]) {
    return { available: false, reason: 'Fuera del tramo con correspondencia' };
  }
  let high = anchors.findIndex((anchor) => anchor[from] >= time);
  if (high <= 0) high = 1;
  const a = anchors[high - 1];
  const b = anchors[high];
  const ratio = (time - a[from]) / (b[from] - a[from]);
  const mappedTime = a[to] + ratio * (b[to] - a[to]);
  const confidence = Math.min(a.confidence, b.confidence);
  if (confidence >= minimumConfidence) {
    return { available: true, time: mappedTime, confidence, approximate: true, fallback: false };
  }
  const reliable = (alignment.markers || [])
    .filter((marker) => marker.confidence >= 0.55)
    .map((marker) => ({ marker, distance: Math.abs(marker[from] - time) }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (reliable && reliable.distance <= 35) {
    return {
      available: true,
      time: reliable.marker[to],
      confidence: reliable.marker.confidence,
      approximate: true,
      fallback: true,
      marker: reliable.marker.label,
    };
  }
  return { available: false, reason: 'Confianza insuficiente en este tramo', confidence };
}

export function noteSummary(note) {
  const equivalent = Number.isFinite(note.equivalentTime)
    ? ` · equivalente en ${note.otherTake}: ${formatTime(note.equivalentTime)}`
    : ' · sin equivalencia fiable';
  const version = note.version === 'mejorado' ? 'Mejorado' : 'Original';
  return `Toma ${note.take} · ${version} · ${formatTime(note.time)}${equivalent} — ${note.text}`;
}

export function gainFromDecibels(decibels) {
  return 10 ** (decibels / 20);
}

export function pairedTimes(logicalTime, offsetSeconds, durations) {
  return {
    original: Math.max(0, Math.min(durations.original, logicalTime)),
    mejorado: Math.max(0, Math.min(durations.mejorado, logicalTime + offsetSeconds)),
  };
}

export function driftExceeds(actualImprovedTime, expectedImprovedTime, tolerance = 0.035) {
  return Math.abs(actualImprovedTime - expectedImprovedTime) > tolerance;
}
