#!/usr/bin/env python3
"""Alineación musical reproducible mediante chroma STFT y Dynamic Time Warping."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RATE = 11025
N_FFT = 4096
HOP = 5512  # ~0,5 s


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
        "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1",
    ], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").copy()


def features(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if len(signal) < N_FFT:
        raise RuntimeError("Audio demasiado corto")
    count = 1 + (len(signal) - N_FFT) // HOP
    times = (np.arange(count) * HOP + N_FFT / 2) / RATE
    chroma = np.zeros((count, 12), dtype=np.float32)
    energy = np.zeros(count, dtype=np.float32)
    flux = np.zeros(count, dtype=np.float32)
    window = np.hanning(N_FFT).astype(np.float32)
    freqs = np.fft.rfftfreq(N_FFT, 1 / RATE)
    usable = (freqs >= 65) & (freqs <= 3500)
    bins = np.flatnonzero(usable)
    midi = 69 + 12 * np.log2(freqs[usable] / 440.0)
    pitch_classes = np.mod(np.rint(midi).astype(int), 12)
    previous = None

    for index in range(count):
        frame = signal[index * HOP:index * HOP + N_FFT]
        energy[index] = math.sqrt(float(np.mean(frame * frame)) + 1e-12)
        magnitude = np.abs(np.fft.rfft(frame * window)).astype(np.float32)
        spectrum = np.log1p(20 * magnitude[bins])
        for pitch in range(12):
            values = spectrum[pitch_classes == pitch]
            if len(values):
                chroma[index, pitch] = float(np.sum(values * values))
        if previous is not None:
            flux[index] = float(np.mean(np.maximum(0, spectrum - previous)))
        previous = spectrum

    chroma -= np.percentile(chroma, 10, axis=0, keepdims=True)
    chroma = np.maximum(chroma, 0)
    norms = np.linalg.norm(chroma, axis=1, keepdims=True)
    chroma /= np.maximum(norms, 1e-8)
    energy_db = 20 * np.log10(np.maximum(energy, 1e-8))
    energy_norm = np.clip((energy_db - np.percentile(energy_db, 10)) / 45, 0, 1)
    flux /= max(float(np.percentile(flux, 95)), 1e-8)
    return times, chroma, np.clip(0.65 * energy_norm + 0.35 * flux, 0, 1)


def active_range(times: np.ndarray, activity: np.ndarray) -> tuple[int, int]:
    threshold = max(0.08, float(np.percentile(activity, 25)) + 0.025)
    active = activity > threshold
    kernel = np.ones(7, dtype=int)
    stable = np.convolve(active.astype(int), kernel, mode="same") >= 3
    indices = np.flatnonzero(stable)
    if not len(indices):
        return 0, len(times) - 1
    return max(0, int(indices[0]) - 2), min(len(times) - 1, int(indices[-1]) + 2)


def distance_matrix(a: np.ndarray, b: np.ndarray, aa: np.ndarray, ab: np.ndarray) -> np.ndarray:
    chroma_distance = 1 - np.clip(a @ b.T, 0, 1)
    activity_distance = np.abs(aa[:, None] - ab[None, :])
    return (0.88 * chroma_distance + 0.12 * activity_distance).astype(np.float32)


def dtw_segment(cost: np.ndarray, band_fraction: float = 0.24) -> list[tuple[int, int]]:
    n, m = cost.shape
    accum = np.full((n, m), np.inf, dtype=np.float32)
    move = np.zeros((n, m), dtype=np.uint8)
    accum[0, 0] = cost[0, 0]
    band = max(24, int(max(n, m) * band_fraction))

    for i in range(n):
        expected = i * (m - 1) / max(1, n - 1)
        start = max(0, int(expected - band))
        end = min(m, int(expected + band) + 1)
        for j in range(start, end):
            if i == 0 and j == 0:
                continue
            candidates: list[tuple[float, int]] = []
            if i >= 1 and j >= 1:
                candidates.append((float(accum[i - 1, j - 1]), 1))
            if i >= 1 and j >= 2:
                candidates.append((float(accum[i - 1, j - 2]) + 0.035, 2))
            if i >= 2 and j >= 1:
                candidates.append((float(accum[i - 2, j - 1]) + 0.035, 3))
            if not candidates:
                continue
            best, code = min(candidates)
            if math.isfinite(best):
                accum[i, j] = cost[i, j] + best
                move[i, j] = code

    if not math.isfinite(float(accum[-1, -1])):
        raise RuntimeError("DTW no alcanzó el final; revise anchors o amplíe la banda")
    path = []
    i, j = n - 1, m - 1
    while True:
        path.append((i, j))
        if i == 0 and j == 0:
            break
        code = int(move[i, j])
        if code == 1:
            i, j = i - 1, j - 1
        elif code == 2:
            i, j = i - 1, j - 2
        elif code == 3:
            i, j = i - 2, j - 1
        else:
            raise RuntimeError("Ruta DTW interrumpida")
    return list(reversed(path))


def nearest_index(times: np.ndarray, seconds: float) -> int:
    return int(np.argmin(np.abs(times - seconds)))


def aligned_path(
    times_a: np.ndarray, times_b: np.ndarray, chroma_a: np.ndarray, chroma_b: np.ndarray,
    activity_a: np.ndarray, activity_b: np.ndarray, start_a: int, end_a: int,
    start_b: int, end_b: int, manual: list[dict],
) -> tuple[list[tuple[int, int]], np.ndarray]:
    controls = [(start_a, start_b)]
    for anchor in manual:
        ia = nearest_index(times_a, float(anchor["t5016"]))
        ib = nearest_index(times_b, float(anchor["t5017"]))
        if start_a < ia < end_a and start_b < ib < end_b:
            controls.append((ia, ib))
    controls.append((end_a, end_b))
    controls = sorted(set(controls))
    if any(a2 <= a1 or b2 <= b1 for (a1, b1), (a2, b2) in zip(controls, controls[1:])):
        raise RuntimeError("Los anchors manuales deben ser estrictamente monotónicos")

    complete: list[tuple[int, int]] = []
    complete_cost = np.full((len(times_a), len(times_b)), np.nan, dtype=np.float32)
    for segment_index, ((a0, b0), (a1, b1)) in enumerate(zip(controls, controls[1:])):
        ca = chroma_a[a0:a1 + 1]
        cb = chroma_b[b0:b1 + 1]
        cost = distance_matrix(ca, cb, activity_a[a0:a1 + 1], activity_b[b0:b1 + 1])
        local = dtw_segment(cost)
        section = [(i + a0, j + b0) for i, j in local]
        if segment_index:
            section = section[1:]
        complete.extend(section)
        complete_cost[a0:a1 + 1, b0:b1 + 1] = cost
    return complete, complete_cost


def smooth_mapping(path: list[tuple[int, int]], count_a: int) -> np.ndarray:
    groups: list[list[int]] = [[] for _ in range(count_a)]
    for i, j in path:
        groups[i].append(j)
    known_i = np.array([i for i, values in enumerate(groups) if values], dtype=float)
    known_j = np.array([np.median(groups[i]) for i in known_i.astype(int)], dtype=float)
    mapped = np.interp(np.arange(count_a), known_i, known_j)
    if len(mapped) >= 9:
        padded = np.pad(mapped, 4, mode="edge")
        mapped = np.convolve(padded, np.ones(9) / 9, mode="valid")
    return np.maximum.accumulate(mapped)


def make_anchors(
    times_a: np.ndarray, times_b: np.ndarray, mapped: np.ndarray, cost: np.ndarray,
    activity_a: np.ndarray, start_a: int, end_a: int,
) -> list[dict]:
    anchors = []
    previous_b = None
    step_frames = max(1, round(2 / (HOP / RATE)))
    slopes = np.gradient(mapped)
    median_slope = float(np.median(slopes[start_a:end_a + 1]))
    for i in range(start_a, end_a + 1, step_frames):
        j = int(round(mapped[i]))
        j = max(0, min(len(times_b) - 1, j))
        chroma_cost = float(cost[i, j]) if math.isfinite(float(cost[i, j])) else 1.0
        local = slopes[max(start_a, i - 5): min(end_a + 1, i + 6)]
        stability = float(np.std(local) / max(0.2, median_slope))
        confidence = math.exp(-2.1 * chroma_cost) * math.exp(-1.5 * stability)
        confidence *= 0.7 + 0.3 * float(activity_a[i])
        t_b = float(times_b[j])
        if previous_b is not None and t_b <= previous_b:
            t_b = previous_b + 0.001
        previous_b = t_b
        anchors.append({
            "t5016": round(float(times_a[i]), 3),
            "t5017": round(t_b, 3),
            "confidence": round(float(np.clip(confidence, 0, 1)), 3),
        })
    if anchors[-1]["t5016"] < float(times_a[end_a]) - 0.75:
        i = end_a
        j = int(round(mapped[i]))
        anchors.append({
            "t5016": round(float(times_a[i]), 3),
            "t5017": round(float(times_b[j]), 3),
            "confidence": round(anchors[-1]["confidence"] * 0.9, 3),
        })
    return anchors


def make_markers(anchors: list[dict], chroma: np.ndarray, times: np.ndarray) -> list[dict]:
    candidates = []
    for index, anchor in enumerate(anchors):
        if anchor["confidence"] < 0.45:
            continue
        frame = nearest_index(times, anchor["t5016"])
        before = max(0, frame - 5)
        novelty = float(np.linalg.norm(chroma[frame] - chroma[before]))
        score = anchor["confidence"] * (0.7 + 0.3 * min(1, novelty))
        candidates.append((score, index, anchor))
    selected: list[tuple[int, dict]] = []
    min_spacing = max(20.0, (anchors[-1]["t5016"] - anchors[0]["t5016"]) / 13)
    for _, index, anchor in sorted(candidates, reverse=True):
        if all(abs(anchor["t5016"] - other["t5016"]) >= min_spacing for _, other in selected):
            selected.append((index, anchor))
        if len(selected) == 10:
            break
    selected.sort()
    return [
        {"id": n, "label": f"Punto {n}", **anchor}
        for n, (_, anchor) in enumerate(selected, 1)
    ]


def diagnostic(path: Path, anchors: list[dict], markers: list[dict], durations: tuple[float, float]) -> None:
    width, height, pad = 1200, 720, 70
    da, db = durations
    def x(t: float) -> float: return pad + t / da * (width - 2 * pad)
    def y(t: float) -> float: return height - pad - t / db * (height - 2 * pad)
    polyline = " ".join(f"{x(a['t5016']):.1f},{y(a['t5017']):.1f}" for a in anchors)
    dots = "\n".join(
        f'<circle cx="{x(m["t5016"]):.1f}" cy="{y(m["t5017"]):.1f}" r="5" fill="#cf5a3b"><title>{m["label"]}</title></circle>'
        for m in markers
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<rect width="100%" height="100%" fill="#fbfaf7"/>
<line x1="{pad}" y1="{height-pad}" x2="{width-pad}" y2="{height-pad}" stroke="#333"/>
<line x1="{pad}" y1="{pad}" x2="{pad}" y2="{height-pad}" stroke="#333"/>
<polyline points="{polyline}" fill="none" stroke="#315d72" stroke-width="2"/>
{dots}
<text x="{width/2}" y="{height-18}" text-anchor="middle" font-family="system-ui" font-size="18">IMG_5016 · segundos absolutos</text>
<text x="20" y="{height/2}" transform="rotate(-90 20 {height/2})" text-anchor="middle" font-family="system-ui" font-size="18">IMG_5017 · segundos absolutos</text>
<text x="{pad}" y="35" font-family="system-ui" font-size="22" font-weight="600">Diagnóstico DTW · chroma STFT</text>
</svg>'''
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-anchors", type=Path, default=ROOT / "config" / "manual-anchors.json")
    args = parser.parse_args()
    paths = [ROOT / "build" / "audio" / f"IMG_{take}_original.m4a" for take in ("5016", "5017")]
    decoded = [decode(path) for path in paths]
    duration_a, duration_b = (len(signal) / RATE for signal in decoded)
    times_a, chroma_a, activity_a = features(decoded[0])
    times_b, chroma_b, activity_b = features(decoded[1])
    start_a, end_a = active_range(times_a, activity_a)
    start_b, end_b = active_range(times_b, activity_b)
    manual_data = json.loads(args.manual_anchors.read_text(encoding="utf-8"))
    manual = manual_data.get("anchors", [])
    path, costs = aligned_path(
        times_a, times_b, chroma_a, chroma_b, activity_a, activity_b,
        start_a, end_a, start_b, end_b, manual,
    )
    mapped = smooth_mapping(path, len(times_a))
    anchors = make_anchors(times_a, times_b, mapped, costs, activity_a, start_a, end_a)
    markers = make_markers(anchors, chroma_a, times_a)

    monotonic = all(
        b["t5016"] > a["t5016"] and b["t5017"] > a["t5017"]
        for a, b in zip(anchors, anchors[1:])
    )
    jumps = [
        (b["t5017"] - a["t5017"]) / (b["t5016"] - a["t5016"])
        for a, b in zip(anchors, anchors[1:])
    ]
    if not monotonic:
        raise RuntimeError("La alineación generada no es estrictamente monotónica")
    if not (6 <= len(markers) <= 15):
        raise RuntimeError(f"Solo se obtuvieron {len(markers)} marcadores fiables")
    # El DTW admite breves calderones/pausas distintas; solo rechazamos saltos
    # incompatibles con la restricción de pendiente del camino.
    if max(jumps) > 2.6 or min(jumps) < 0.2:
        raise RuntimeError(f"Salto anómalo en la alineación: pendiente {min(jumps):.2f}–{max(jumps):.2f}")

    output = {
        "schemaVersion": 1,
        "method": "chroma-STFT + DTW coseno; correspondencia aproximada",
        "hopSeconds": round(HOP / RATE, 6),
        "takes": {
            "5016": {"duration": round(duration_a, 3), "activeStart": round(float(times_a[start_a]), 3), "activeEnd": round(float(times_a[end_a]), 3)},
            "5017": {"duration": round(duration_b, 3), "activeStart": round(float(times_b[start_b]), 3), "activeEnd": round(float(times_b[end_b]), 3)},
        },
        "anchors": anchors,
        "markers": markers,
        "validation": {
            "monotonic": monotonic,
            "coverage5016": round((anchors[-1]["t5016"] - anchors[0]["t5016"]) / duration_a, 4),
            "coverage5017": round((anchors[-1]["t5017"] - anchors[0]["t5017"]) / duration_b, 4),
            "slopeMin": round(min(jumps), 3),
            "slopeMax": round(max(jumps), 3),
            "meanConfidence": round(float(np.mean([a["confidence"] for a in anchors])), 3),
            "manualAnchors": len(manual),
        },
    }
    target = ROOT / "docs" / "data" / "alignment.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    diagnostic(ROOT / "reports" / "alignment-diagnostic.svg", anchors, markers, (duration_a, duration_b))
    print(json.dumps(output["validation"], indent=2))
    print(f"Marcadores fiables: {len(markers)}")


if __name__ == "__main__":
    main()
