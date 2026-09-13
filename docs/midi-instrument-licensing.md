# Sampled MIDI instrument licensing

This project ships two sampled-instrument SoundFont 2 banks for browser MIDI
rendering. They are instrument banks, not finished musical recordings: each
bank contains recorded sample data plus SoundFont zones, envelopes, and
program/bank assignments. MIDI files contain note/control events and do not
include these samples. A rendered composition should not be described as a
redistribution of the bank unless the bank itself is also being distributed.

This document records the exact files currently shipped, their source
permissions, and the inspection performed on the binary banks. It is not a
substitute for jurisdiction-specific legal advice.

## Shipped banks

### Fluid R3 GM (full stereo, on-demand)

| Field | Value |
| --- | --- |
| Served file | `public/soundfonts/fluidr3-gm.sf2` |
| Source download | [FluidR3_GM.sf2, Fluid SoundFont release v3.1](https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2) |
| Source/release page | [pianobooster/fluid-soundfont v3.1](https://github.com/pianobooster/fluid-soundfont/releases/tag/v3.1) |
| Format | SF2, SoundFont 2.01 |
| Source release size | 148,398,306 bytes (141.52 MiB) |
| Shipped SHA-256 | `74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0` |
| Embedded name/date | `Fluid R3 GM`; `Feb 24. 2008` |
| Embedded author/rights | Frank Wen; “Licensed under the MIT License.” |
| Local permissions | [`licenses/fluidr3.COPYING`](../artifacts/film-score-studio/public/soundfonts/licenses/fluidr3.COPYING), [`licenses/fluidr3.README`](../artifacts/film-score-studio/public/soundfonts/licenses/fluidr3.README) |

The release README states that Fluid was constructed partly from edited,
cleaned, remixed, and programmed public-domain samples and largely from
recordings by Frank Wen and the named contributors in that README. It also
credits Toby Smithe in the embedded SF2 metadata. This is provenance evidence,
not an objective claim that it is the highest-rated bank.

The MIT text grants permission to use, copy, modify, merge, publish,
distribute, sublicense, and sell the Software. Any redistributed copy or
substantial portion must retain the copyright and permission notice. Keep the
original Fluid README and COPYING files alongside any served or repackaged
bank so the credits and disclaimer travel with it.

#### Programs verified from `pdta/phdr`

The bank was inspected as a RIFF SoundFont file. The terminal `EOP` record was
excluded from the count; all other preset-header records were counted.

* 189 playable preset records.
* 128 bank-0 General MIDI programs.
* 28 bank-8 variations, one bank-9 effect, and one bank-16 variation.
* 31 bank-128 percussion/kit programs.
* Representative melodic assignments include `0:0 Yamaha Grand Piano`,
  `0:1 Bright Yamaha Grand`, `0:3 Honky Tonk`, `0:40 Violin`, `0:41 Viola`,
  `0:42 Cello`, `0:48 Strings`, `0:56 Trumpet`, `0:57 Trombone`,
  `0:60 French Horns`, `0:68 Oboe`, `0:69 English Horn`, `0:71 Clarinet`,
  `0:73 Flute`, `0:74 Recorder`, `0:75 Pan Flute`, and the GM guitar,
  bass, pad, synth, and effect programs.
* Representative variation/kit assignments include `8:48 Orchestral Pad`,
  `8:40 Slow Violin`, `8:25 12 String Guitar`, `128:0 Standard`,
  `128:32 Jazz`, `128:40 Brush`, and `128:48 Orchestra Kit`.

### FreePats Upright Piano KW (full stereo, piano default)

| Field | Value |
| --- | --- |
| Served file | `public/soundfonts/upright-piano-kw.sf2` |
| Source archive | [UprightPianoKW-SF2-20220221.7z](https://freepats.zenvoid.org/Piano/UprightPianoKW/UprightPianoKW-SF2-20220221.7z) |
| Source details | [FreePats Acoustic Grand Piano page, Upright KW](http://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#UprightKW) |
| Extracted source filename | `UprightPianoKW-20220221.sf2` |
| Archive size | 28,832,466 bytes (27.5 MiB) |
| Source archive SHA-256 | `17c084c6e4205233dc49b34e4bc44a9b2d7c7a2c02b04729ecda77079b07c826` |
| Extracted SF2 size | 57,377,848 bytes (54.72 MiB; FreePats lists 56 MiB) |
| Shipped SHA-256 | `d9f5157720963671906727ca2e12b3293fd822c831bb0de477dd1c5f3ad37108` |
| Version/date | 2022-02-21 |
| License | Creative Commons CC0 1.0 |
| Local permissions/credits | [`licenses/upright-piano-kw-cc0.txt`](../artifacts/film-score-studio/public/soundfonts/licenses/upright-piano-kw-cc0.txt), [`licenses/upright-piano-kw-readme.txt`](../artifacts/film-score-studio/public/soundfonts/licenses/upright-piano-kw-readme.txt) |

The original FreePats readme says this is a Kawai upright piano in a living
room, recorded in January 2017 by Gonzalo and Roberto with a Zoom H1 mounted
approximately where a piano player’s head would be. The raw recordings were
cropped, edited, and processed by Roberto. FreePats describes the full bank as
stereo with two velocity layers. The SF2 contains one verified preset:
`bank 0, program 0, Upright Piano KW`.

CC0 dedicates the work to the public domain, including commercial use. Keep
the original CC0 and readme files with the asset even though CC0 does not
require attribution; they document the actual recording provenance and source
version.

## Loading policy and cost

The two full-resolution banks are intentionally separate:

* Use the upright piano as the piano default, but fetch it lazily when piano
  playback is first needed. Do not make the 54.72 MiB piano payload part of the
  initial application download.
* Fetch Fluid R3 GM on demand for non-piano GM/orchestral programs. Its 141.52
  MiB payload is deliberately the full stereo bank rather than the smaller
  mono SF3 conversion.
* If both banks are used in one session, the raw SF2 payloads total about
  196.24 MiB before browser decoding and AudioBuffer/sample memory overhead.
  Cache each bank after its first successful decode and show loading progress;
  do not silently substitute a different bank.
* These are binary sample payloads, so ordinary text compression should not be
  expected to remove the main download cost. The load cost is why on-demand
  fetches are required even though the larger stereo bank is preferred for
  playback quality.

## Engine attribution

The browser renderer uses `spessasynth_lib` 4.3.14 and its
`spessasynth_core` 4.3.22 dependency. Both packages are Apache License 2.0.
The exact license texts are preserved in:

* [`licenses/spessasynth-lib.apache-2.0.txt`](../artifacts/film-score-studio/public/soundfonts/licenses/spessasynth-lib.apache-2.0.txt)
* [`licenses/spessasynth-core.apache-2.0.txt`](../artifacts/film-score-studio/public/soundfonts/licenses/spessasynth-core.apache-2.0.txt)

Upstream references: [spessasynth_lib package](https://www.npmjs.com/package/spessasynth_lib),
[spessasynth_lib source license](https://github.com/spessasus/spessasynth_lib/blob/master/LICENSE),
and [spessasynth_core source license](https://github.com/spessasus/spessasynth_core/blob/master/LICENSE).
The Apache notice is for the synth engine; it does not replace the separate
Fluid MIT or FreePats CC0 notice.

## Research exclusions

These candidates were researched but are not shipped:

* **FluidR3Mono** is smaller and has an MIT license, but the selected default is
  the full stereo `FluidR3_GM.sf2` for quality. Its license/provenance remains
  available from [LibreScore’s exact-bank license record](https://raw.githubusercontent.com/LibreScore/sf3/master/FluidR3Mono_License.md).
* **MuseScore MS Basic** has broad GM/GS coverage and expressive presets, but
  the official `MS Basic_License.md` still identifies the work as
  `MuseScore_General.sf2` (version 0.2, May 2020). MuseScore’s own licensing
  discussion documents the stale-name ambiguity, so it is not used as the
  cleanest commercial-redistribution choice:
  [bank](https://raw.githubusercontent.com/musescore/MuseScore/main/share/sound/MS%20Basic.sf3),
  [license](https://raw.githubusercontent.com/musescore/MuseScore/main/share/sound/MS%20Basic_License.md),
  [official discussion](https://musescore.org/en/node/378772).
* **Salamander Grand Piano** has strong recording evidence (Yamaha C5,
  48 kHz/24-bit, 16 velocity layers, release/resonance layers), but the
  official FreePats entry is CC BY 3.0 rather than CC0 and its SF2 is about
  296 MiB. It would require attribution and is too large for the default
  browser piano: [FreePats entry](http://freepats.zenvoid.org/Piano/acoustic-grand-piano.html),
  [license text](https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/LICENSE).
* **VSCO 2 Community Edition** is CC0, but the authoritative distribution is
  SFZ/WAV rather than SF2/SF3. Versilian explicitly says SFZ and SF2 are not
  directly compatible, and the source is about 2.3–3 GiB:
  [official page](https://versilian-studios.com/vsco-community),
  [SFZ release](https://github.com/sgossner/VSCO-2-CE/releases/tag/1.1.0),
  [CC0 license](https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/LICENSE).
  No unverified third-party SF2 export is bundled.
* **Arachno** documents 128 GM instruments and nine GM/GS kits, but its author
  says the bank is primarily private/non-commercial and commercial use needs
  written consent from the original credited authors:
  [official documentation](https://www.arachnosoft.com/main/soundfont.php?documentation).
* **GeneralUser GS 2.0.3** permits music production but its own license says
  the author cannot be completely sure where all samples originated and warns
  that this uncertainty may concern commercial software:
  [license](https://github.com/mrbumpy409/GeneralUser-GS/blob/main/documentation/LICENSE.txt).
