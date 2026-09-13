# Film Score Studio modern sample sources

The `modern-*.wav` files in this directory are original, deterministic PCM
renders generated for Film Score Studio. They were created specifically for
this project by `scripts/generate-modern-samples.mjs`; no third-party audio,
recording, loop, or waveform file is embedded in them. The generator combines
mathematical partials, deterministic seeded noise, and offline amplitude
envelopes into mono 16-bit, 22.05 kHz RIFF/WAV files.

These files are shipped as sampled audio and decoded with `decodeAudioData`.
They are not runtime oscillator fallbacks. Browser playback always routes
through one of these WAV files (or the existing CC0 orchestral/piano WAV
files), which keeps iPadOS Safari and Chromium on the same PCM path.

To reproduce the assets after a clean checkout:

```sh
cd artifacts/film-score-studio
node scripts/generate-modern-samples.mjs
```

The existing piano and orchestra sources remain separately documented by
`CC0-1.0-LICENSE.txt`, `VSCO-2-CE-CC0-LICENSE.txt`, and their source notes.