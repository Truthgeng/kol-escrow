# Free voiceover for the demo video: Kokoro-82M (Apache 2.0), one WAV per line of demo/vo.json.
import json, sys, numpy as np, soundfile as sf
from kokoro import KPipeline
cfg = json.load(open(sys.argv[1])); out = sys.argv[2]
voice = sys.argv[3] if len(sys.argv) > 3 else cfg["voice"]
pipe = KPipeline(lang_code=voice[0])
for name, start, text in cfg["lines"]:
    audio = np.concatenate([a for _, _, a in pipe(text, voice=voice, speed=cfg["speed"])])
    sf.write(f"{out}/{voice}-{name}.wav", audio, 24000)
    print(f"{voice}-{name} {len(audio)/24000:.2f}s starts {start}s: {text}")
