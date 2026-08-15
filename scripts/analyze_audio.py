#!/usr/bin/env python3
"""Analiza sonoridad, offset A/B y waveforms sin modificar los audios."""

from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "build" / "audio"
TAKES = ("5016", "5017")
VERSIONS = ("original", "mejorado")


def probe(path: Path) -> dict:
    out = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=bit_rate,sample_rate,channels,codec_name",
        "-show_entries", "format=duration,size", "-of", "json", str(path),
    ], check=True, capture_output=True, text=True).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    return {
        "duration": float(data["format"]["duration"]),
        "size": int(data["format"]["size"]),
        "bitrate": int(stream["bit_rate"]),
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "codec": stream["codec_name"],
    }


def decode_mono(path: Path, rate: int = 4000) -> np.ndarray:
    out = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
        "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1",
    ], check=True, capture_output=True).stdout
    return np.frombuffer(out, dtype="<f4").copy()


def loudness(path: Path) -> dict:
    proc = subprocess.run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", "loudnorm=I=-23:LRA=7:TP=-2:print_format=json", "-f", "null", "-",
    ], capture_output=True, text=True)
    match = re.search(r"\{\s*\"input_i\".*?\}", proc.stderr, re.S)
    if proc.returncode or not match:
        raise RuntimeError(f"No se pudo analizar loudnorm: {path.name}")
    raw = json.loads(match.group(0))
    return {
        "integratedLufs": float(raw["input_i"]),
        "truePeakDbtp": float(raw["input_tp"]),
        "loudnessRangeLu": float(raw["input_lra"]),
        "thresholdLufs": float(raw["input_thresh"]),
    }


def envelope(signal: np.ndarray, rate: int, hz: int = 100) -> np.ndarray:
    block = max(1, rate // hz)
    signal = signal[: len(signal) // block * block]
    env = np.sqrt(np.mean(signal.reshape(-1, block) ** 2, axis=1) + 1e-12)
    return np.diff(np.log1p(env * 1000), prepend=0)


def estimate_offset(reference: np.ndarray, target: np.ndarray, rate: int = 4000) -> dict:
    """Devuelve target_time = reference_time + offset."""
    a = envelope(reference, rate)
    b = envelope(target, rate)
    limit = 200  # +/- 2 s a 100 Hz
    scores = []
    for lag in range(-limit, limit + 1):
        if lag >= 0:
            aa, bb = a[: min(len(a), len(b) - lag)], b[lag: lag + min(len(a), len(b) - lag)]
        else:
            aa, bb = a[-lag: -lag + min(len(a) + lag, len(b))], b[: min(len(a) + lag, len(b))]
        if len(aa) < 100:
            score = -1.0
        else:
            aa = aa - aa.mean()
            bb = bb - bb.mean()
            score = float(np.dot(aa, bb) / (np.linalg.norm(aa) * np.linalg.norm(bb) + 1e-12))
        scores.append(score)
    best_index = int(np.argmax(scores))
    lag = best_index - limit
    ordered = np.sort(np.asarray(scores))
    return {
        "seconds": round(lag / 100, 4),
        "correlation": round(scores[best_index], 4),
        "prominence": round(scores[best_index] - float(ordered[-6]), 4),
        "reliable": bool(scores[best_index] > 0.65),
    }


def waveform(signal: np.ndarray, points: int = 900) -> list[float]:
    length = len(signal) // points
    trimmed = signal[: length * points]
    peaks = np.max(np.abs(trimmed.reshape(points, length)), axis=1)
    scale = float(np.percentile(peaks, 99.5)) or 1.0
    return np.round(np.clip(peaks / scale, 0, 1), 4).tolist()


def main() -> None:
    (ROOT / "docs" / "data").mkdir(parents=True, exist_ok=True)
    analysis: dict = {"takes": {}}
    waveforms: dict = {"takes": {}}
    decoded: dict[tuple[str, str], np.ndarray] = {}

    for take in TAKES:
        analysis["takes"][take] = {"versions": {}}
        waveforms["takes"][take] = {"versions": {}}
        for version in VERSIONS:
            path = AUDIO / f"IMG_{take}_{version}.m4a"
            decoded[(take, version)] = decode_mono(path)
            info = probe(path)
            metric = loudness(path)
            analysis["takes"][take]["versions"][version] = {**info, **metric}
            waveforms["takes"][take]["versions"][version] = waveform(decoded[(take, version)])
            print(f"{take} {version}: {metric['integratedLufs']:.2f} LUFS")

        offset = estimate_offset(decoded[(take, "original")], decoded[(take, "mejorado")])
        analysis["takes"][take]["abOffset"] = offset
        if not offset["reliable"]:
            raise RuntimeError(f"La pareja A/B de {take} no se pudo alinear con fiabilidad: {offset}")
        levels = [analysis["takes"][take]["versions"][v]["integratedLufs"] for v in VERSIONS]
        target_lufs = min(levels)
        analysis["takes"][take]["comparisonTargetLufs"] = target_lufs
        for version in VERSIONS:
            item = analysis["takes"][take]["versions"][version]
            item["matchGainDb"] = round(min(0.0, target_lufs - item["integratedLufs"]), 2)
        print(f"{take} offset mejorado: {offset['seconds']:+.3f}s, r={offset['correlation']:.3f}")

    (ROOT / "build" / "audio-analysis.json").write_text(
        json.dumps(analysis, indent=2) + "\n", encoding="utf-8"
    )
    (ROOT / "docs" / "data" / "waveforms.json").write_text(
        json.dumps(waveforms, separators=(",", ":")) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
