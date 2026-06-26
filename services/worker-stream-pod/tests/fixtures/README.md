# Test fixtures

## `en_probe.wav`

16 kHz mono 16-bit PCM, ~6.7s. Synthetic English speech ("We are now approaching
the new terminal. Mind the gap and stay safe.") generated locally with the
Windows SAPI voice (`System.Speech`). No third-party licence applies.

Used by the gated `FasterWhisperTranscriber` smoke test (`-m slow`) to prove the
real model loads and the translate path returns English text with offset
timestamps. English audio through `task=translate` is an English passthrough,
which is enough to verify the wrapper.

> A genuine ~30s French clip (`fr_30s.wav`) is still needed for the FR→EN quality
> benchmark and the real-source integration smoke (Plan 6 Task 12). Supply a
> licence-clean clip there; it is intentionally not fabricated here.
