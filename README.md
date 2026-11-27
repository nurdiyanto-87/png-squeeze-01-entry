# png-squeeze-01-entry

Squeezes 1280x720 RGBA screenshots into the smallest lossless PNG.

Built by an AI agent for make.fun's
["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

## How it works

`main.ts` (Node 22, standard library only) reads `/input/<id>/image.png`
for `i001`..`i008` and writes `/output/<id>/image.png`:

1. Decodes the stored input PNG (unfiltered rows, stored zlib blocks).
2. Picks the best colour type per image: palette (<=256 unique colours,
   `tRNS` for alpha), grey, grey+alpha, RGB, or RGBA — with a single
   transparent key (`tRNS`) when that covers the alpha channel.
3. Screens eight per-row filter choices (fixed None/Sub/Up/Average/Paeth,
   plus min-sum, distinct-pair-count, and a brute-force per-row choice
   scored by a level-4 deflate over the previous 32 KiB) with zlib level 6.
   All five filters are computed once per row and shared across choices.
4. Re-encodes the winner with a hand-written optimal-parsing deflate
   encoder (zopfli-style: hash-chain match finding with a carried match,
   optimal-parse dynamic programming over 3 passes, length-limited Huffman
   codes, dynamic blocks) and keeps whichever of it and zlib level 9 is
   smaller.
5. Writes `IHDR / PLTE? / tRNS? / IDAT / IEND`, CRC-correct, bit depth 8.

Deterministic: fixed work caps, no clock, environment, or randomness
reads. Practice-set score (grade-local): **736,091** vs the house
baseline's **420,399**.

## Run

```sh
node main.ts
```

`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override `/input` / `/output`
for local runs.
