#!/usr/bin/env python3
"""Extrae AAC de MOV a M4A sin recodificar y verifica los paquetes."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = [
    ("5016", "original"),
    ("5016", "mejorado"),
    ("5017", "original"),
    ("5017", "mejorado"),
]


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=True, capture_output=capture)


def probe(path: Path) -> dict:
    result = run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,bit_rate,sample_rate,channels",
        "-show_entries", "format=duration,size", "-of", "json", str(path),
    ], capture=True)
    data = json.loads(result.stdout)
    if not data.get("streams"):
        raise RuntimeError(f"No hay pista de audio en {path}")
    stream = data["streams"][0]
    return {
        "codec": stream.get("codec_name"),
        "bitrate": int(stream.get("bit_rate", 0)),
        "sampleRate": int(stream.get("sample_rate", 0)),
        "channels": int(stream.get("channels", 0)),
        "duration": float(data["format"]["duration"]),
        "size": int(data["format"]["size"]),
    }


def packet_hash(path: Path) -> str:
    """Hash del flujo de payloads AAC, independiente del contenedor."""
    proc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
        "-c:a", "copy", "-f", "data", "pipe:1",
    ], stdout=subprocess.PIPE)
    digest = hashlib.sha256()
    assert proc.stdout is not None
    for block in iter(lambda: proc.stdout.read(1024 * 1024), b""):
        digest.update(block)
    if proc.wait() != 0:
        raise RuntimeError(f"No se pudo calcular el hash AAC de {path}")
    return digest.hexdigest()


def locate(inputs: Path, take: str, version: str) -> Path:
    matches = [p for p in inputs.glob(f"IMG_{take}_{version}.*") if p.is_file()]
    if len(matches) != 1:
        raise RuntimeError(
            f"Se esperaba exactamente un archivo IMG_{take}_{version}.*, encontrados: {matches}"
        )
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, default=ROOT / "inputs")
    parser.add_argument("--output", type=Path, default=ROOT / "build" / "audio")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records = []

    for take, version in EXPECTED:
        source = locate(args.inputs, take, version)
        source_info = probe(source)
        if source_info["codec"] != "aac":
            raise RuntimeError(f"{source.name}: se requiere AAC, no {source_info['codec']}")
        if source_info["sampleRate"] != 48000 or source_info["channels"] != 2:
            raise RuntimeError(f"{source.name}: se requiere AAC estéreo a 48 kHz")
        if source_info["bitrate"] < 100_000:
            raise RuntimeError(f"{source.name}: bitrate sospechosamente bajo")

        target = args.output / f"IMG_{take}_{version}.m4a"
        if source.suffix.lower() == ".m4a":
            shutil.copyfile(source, target)
        else:
            run([
                "ffmpeg", "-y", "-v", "error", "-i", str(source),
                "-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", str(target),
            ])

        source_hash = packet_hash(source)
        target_hash = packet_hash(target)
        if source_hash != target_hash:
            target.unlink(missing_ok=True)
            raise RuntimeError(f"La extracción alteró el flujo AAC de {source.name}")

        target_info = probe(target)
        records.append({
            "take": take,
            "version": version,
            "source": source.name,
            "output": target.name,
            "sourceInfo": source_info,
            "outputInfo": target_info,
            "aacPacketSha256": target_hash,
            "verifiedStreamCopy": True,
        })
        print(f"OK {source.name} -> {target.name} ({source_hash[:12]}…)")

    report = ROOT / "build" / "extraction-report.json"
    report.write_text(json.dumps({"files": records}, indent=2) + "\n", encoding="utf-8")
    print(f"Informe: {report.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
