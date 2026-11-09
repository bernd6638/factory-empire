"""
Discord OS – lokaler Sprachdienst für den KI-Sprach-Bot.

  POST /stt   WAV (16 kHz Mono) → {"text": ...}          (faster-whisper)
  POST /tts   {"text", "voice", "length_scale"} → WAV     (Piper)
  GET  /voices                                            verfügbare deutsche Stimmen
  GET  /health                                            Status

Alles läuft lokal. Audio wird nur im Arbeitsspeicher verarbeitet und nicht gespeichert.
Modelle werden beim ersten Bedarf heruntergeladen und im Volume /models zwischengespeichert.
"""
import io
import logging
import os
import threading
import time
import urllib.request
import wave

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice-ai")

MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
CPU_THREADS = int(os.environ.get("CPU_THREADS", "6"))
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Deutsche Piper-Stimmen (Name → Pfad im offiziellen Piper-Stimmen-Repository)
VOICES = {
    "de_DE-thorsten-medium": "de/de_DE/thorsten/medium",
    "de_DE-thorsten-high": "de/de_DE/thorsten/high",
    "de_DE-thorsten_emotional-medium": "de/de_DE/thorsten_emotional/medium",
    "de_DE-kerstin-low": "de/de_DE/kerstin/low",
    "de_DE-ramona-low": "de/de_DE/ramona/low",
    "de_DE-eva_k-x_low": "de/de_DE/eva_k/x_low",
    "de_DE-karlsson-low": "de/de_DE/karlsson/low",
    "de_DE-pavoque-low": "de/de_DE/pavoque/low",
}

app = FastAPI(title="Discord OS Voice AI")
_whisper = None
_whisper_lock = threading.Lock()
_voices: dict = {}
_voice_lock = threading.Lock()


def get_whisper():
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            log.info("Lade Whisper-Modell %s (%s/%s) …", WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
            _whisper = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE,
                cpu_threads=CPU_THREADS,
                download_root=os.path.join(MODELS_DIR, "whisper"),
            )
        return _whisper


def get_voice(name: str):
    if name not in VOICES:
        raise HTTPException(400, f"Unbekannte Stimme: {name}")
    with _voice_lock:
        if name in _voices:
            return _voices[name]
        from piper import PiperVoice

        folder = os.path.join(MODELS_DIR, "piper")
        os.makedirs(folder, exist_ok=True)
        onnx = os.path.join(folder, f"{name}.onnx")
        for suffix in (".onnx", ".onnx.json"):
            target = os.path.join(folder, f"{name}{suffix}")
            if not os.path.exists(target):
                url = f"{PIPER_BASE}/{VOICES[name]}/{name}{suffix}"
                log.info("Lade Stimme %s …", url)
                tmp = target + ".part"
                urllib.request.urlretrieve(url, tmp)
                os.replace(tmp, target)
        _voices[name] = PiperVoice.load(onnx)
        return _voices[name]


def read_wav_16k_mono(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise HTTPException(400, "Nur 16-Bit-PCM-WAV wird unterstützt")
        frames = w.readframes(w.getnframes())
        rate, channels = w.getframerate(), w.getnchannels()
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # Lineare Umrechnung auf 16 kHz (Whisper erwartet 16 kHz)
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


_stt_lock = threading.Lock()


def _transcribe(data: bytes, language: str) -> dict:
    audio = read_wav_16k_mono(data)
    t0 = time.time()
    # Eine Erkennung gleichzeitig – mehrere parallel würden sich die CPU-Kerne nur gegenseitig wegnehmen
    with _stt_lock:
        segments, info = get_whisper().transcribe(
            audio,
            language=language or None,
            beam_size=1,
            best_of=1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    ms = int((time.time() - t0) * 1000)
    log.info("STT %.1fs Audio in %d ms: %s", len(audio) / 16000, ms, text[:80])
    return {"text": text, "language": info.language, "seconds": round(len(audio) / 16000, 2), "ms": ms}


@app.post("/stt")
async def stt(request: Request, language: str = "de"):
    data = await request.body()
    if not data:
        raise HTTPException(400, "Leerer Audioinhalt")
    # Rechenintensive Erkennung in einem Thread – der Dienst bleibt währenddessen für /health und /tts erreichbar
    return await run_in_threadpool(_transcribe, data, language)


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    voice: str = "de_DE-thorsten-medium"
    length_scale: float = Field(1.0, ge=0.4, le=2.5)


@app.post("/tts")
def tts(body: TtsBody):
    from piper import SynthesisConfig

    voice = get_voice(body.voice)
    t0 = time.time()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize_wav(body.text, wav_file, syn_config=SynthesisConfig(length_scale=body.length_scale))
    log.info("TTS %d Zeichen in %d ms", len(body.text), int((time.time() - t0) * 1000))
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.get("/voices")
def voices():
    folder = os.path.join(MODELS_DIR, "piper")
    return [{"id": v, "downloaded": os.path.exists(os.path.join(folder, f"{v}.onnx"))} for v in VOICES]


@app.get("/health")
def health():
    return {
        "ok": True,
        "whisperModel": WHISPER_MODEL,
        "whisperLoaded": _whisper is not None,
        "device": WHISPER_DEVICE,
        "voices": list(_voices.keys()),
    }


@app.on_event("startup")
def warmup():
    # Modelle im Hintergrund vorladen, damit die erste Antwort nicht lange dauert
    def run():
        try:
            get_whisper()
            get_voice(os.environ.get("DEFAULT_VOICE", "de_DE-thorsten-medium"))
            log.info("Sprachdienst bereit")
        except Exception as exc:  # noqa: BLE001
            log.warning("Vorladen fehlgeschlagen (wird beim ersten Aufruf erneut versucht): %s", exc)

    threading.Thread(target=run, daemon=True).start()
