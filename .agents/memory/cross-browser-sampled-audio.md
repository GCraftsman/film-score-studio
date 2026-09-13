---
name: Cross-browser MIDI audio and microphone capture
description: Gesture activation, SoundFont licensing, and microphone codec constraints across iPad Safari and Chromium.
---

Instrument playback must use a MIDI SoundFont synthesizer with mapped zones, envelopes, loops, and percussion keys, not the former single-WAV pitch-shifting adapter. Begin AudioContext activation synchronously in the original pointer or touch event before awaiting worklet or bank loading.

**Why:** The user rejected the former playback quality and explicitly requested actual MIDI instruments licensed for redistribution in a shared app. Royalty-free use in recordings alone does not authorize hosting a playable library.

**How to apply:** Check original bank permissions and sample provenance; preserve credits. Remove unsupported instruments from selection and agent routing but preserve saved notes for explicit replacement. Favor cached, lazy bank loading because full stereo banks are large. Do not claim real iPad Safari validation based on Chromium touch emulation.

An exposed AudioWorklet API does not prove that processor registration works in the preview browser.

**Why:** On 2026-09-11, secure-context Chromium 140 left both the real processor and a trivial independent Blob processor's addModule promises pending, with a running AudioContext and no network errors. Changing Vite delivery did not resolve the independent probe.

**How to apply:** Bound worklet startup and provide an explicit compatibility path using the same MIDI/SoundFont synthesis, not a return to single-sample playback. Test output signal, not just API presence or a Ready label.

For microphone features that need both playback and signal analysis, retain the MediaRecorder blob for playback/storage but analyze PCM captured directly from the live stream rather than decoding the compressed blob afterward.

**Why:** Opus-in-OGG decoded in desktop Chromium but can fail on iPad Safari. AAC-in-M4A targets Safari but failed to decode in the Replit Chromium runtime. PCM WAV passed browser decoding and playback-source checks in the same implementation. Chromium also accepted a native MediaRecorder WebM for playback while rejecting the same blob through `decodeAudioData`; live PCM avoided that inconsistent codec path.

**How to apply:** PCM WAV remains suitable for utility clicks or rendered previews, not the instrument engine. Keep the explicit audio-unlock control for iOS/iPadOS. For recorded-input analysis, capture PCM only while recording, mute the processing output, and release the stream, processor, context, timers, and object URLs on every exit path.