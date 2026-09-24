"""Forced-alignment sidecar for the NGSL clip pipeline.

Human subtitles give the right words at roughly the right time, often a few
hundred milliseconds off, which is enough to cut a word in half. This service
matches each sentence's text against the audio with a wav2vec2 CTC model
(torchaudio's WAV2VEC2_ASR_BASE_960H, the English aligner WhisperX uses) and
returns when every word is really spoken. The worker cuts clips on those times.

API (JSON over HTTP, one request per source video):

    GET  /health  -> {"ok": true}
    POST /align   {"audio": "/tmp/ngsl-clips/<job>/speech.wav",
                   "segments": [{"id": 1, "startMs": 1200, "endMs": 4800, "text": "..."}]}
               -> {"results": [{"id": 1, "ok": true, "startMs": 1310, "endMs": 4620,
                                "score": 0.87, "words": [{"w": "Hello", "s": 1310, "e": 1590}]},
                               {"id": 2, "ok": false}]}

The audio must be 16 kHz mono 16-bit PCM WAV on the scratch volume both
containers share. A segment fails (ok: false) when its first or last word
cannot be aligned, e.g. a number, since the edges are exactly what a cut needs.
"""

import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
import torchaudio

torch.set_num_threads(int(os.environ.get("ALIGNER_THREADS", max(1, (os.cpu_count() or 2) // 2))))

BUNDLE = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
MODEL = BUNDLE.get_model().eval()
LABELS = BUNDLE.get_labels()  # ('-', '|', 'E', 'T', ...): blank, word separator, letters
TOKEN = {label: index for index, label in enumerate(LABELS)}
SAMPLE_RATE = int(BUNDLE.sample_rate)

# Subtitle timing can be off either way; align inside this much extra audio.
CONTEXT_MS = 1000
# One inference at a time: the model already uses every thread it is given.
LOCK = threading.Lock()


def load_wav(path):
    with wave.open(path, "rb") as source:
        if source.getframerate() != SAMPLE_RATE or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError(f"{path} must be {SAMPLE_RATE} Hz mono 16-bit PCM")
        frames = source.readframes(source.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def spelled(word):
    """The characters of a word the English model can emit: A-Z and the apostrophe."""
    return re.sub(r"[^A-Z']", "", word.upper().replace("’", "'")).strip("'")


def align_segment(audio, segment):
    words = [(word, spelled(word)) for word in segment["text"].split()]
    if not words or not words[0][1] or not words[-1][1]:
        return None  # an unalignable edge word would leave the cut guessing
    words = [(word, letters) for word, letters in words if letters]

    start_ms = max(0, int(segment["startMs"]) - CONTEXT_MS)
    end_ms = min(len(audio) * 1000 // SAMPLE_RATE, int(segment["endMs"]) + CONTEXT_MS)
    chunk = audio[start_ms * SAMPLE_RATE // 1000 : end_ms * SAMPLE_RATE // 1000]
    if len(chunk) < SAMPLE_RATE // 4:
        return None

    transcript = "|".join(letters for _, letters in words)
    targets = torch.tensor([[TOKEN[c] for c in transcript]], dtype=torch.int32)

    with torch.inference_mode():
        emission, _ = MODEL(torch.from_numpy(chunk).unsqueeze(0))
        emission = torch.log_softmax(emission, dim=-1)
    if emission.shape[1] < targets.shape[1]:
        return None  # more letters than audio frames: the text is not in this audio

    alignment, scores = torchaudio.functional.forced_align(emission, targets, blank=0)
    spans = torchaudio.functional.merge_tokens(alignment[0], scores[0].exp())
    if len(spans) != targets.shape[1]:
        return None

    ms_per_frame = (len(chunk) / emission.shape[1]) * 1000 / SAMPLE_RATE
    timings, letter_scores = [], []
    index = 0
    for word, letters in words:
        word_spans = spans[index : index + len(letters)]
        index += len(letters) + 1  # skip the '|' separator
        letter_scores.extend(span.score for span in word_spans)
        timings.append(
            {
                "w": word,
                "s": start_ms + round(word_spans[0].start * ms_per_frame),
                "e": start_ms + round(word_spans[-1].end * ms_per_frame),
            }
        )

    return {
        "startMs": timings[0]["s"],
        "endMs": timings[-1]["e"],
        "score": round(float(np.mean(letter_scores)), 4),
        "words": timings,
    }


def align_request(body):
    audio = load_wav(body["audio"])
    results = []
    with LOCK:
        for segment in body["segments"]:
            try:
                aligned = align_segment(audio, segment)
            except Exception as error:  # one bad sentence must not sink the video
                print(f"segment {segment.get('id')} failed: {error}", flush=True)
                aligned = None
            results.append({"id": segment["id"], "ok": True, **aligned} if aligned else {"id": segment["id"], "ok": False})
    return {"results": results}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/align":
            self._send(404, {"error": "not found"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            self._send(200, align_request(body))
        except Exception as error:
            self._send(400, {"error": str(error)})

    def log_message(self, format, *args):
        pass  # one line per request would drown the useful output


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"aligner listening on :{port} ({torch.get_num_threads()} threads)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
