**This package exports 2 scripts:**

 - `create-musescore-video` - an utility to generate videos from MuseScore files
 - `score-util` - used to generate videos with different audio tracks

All ideas and improvements are welcome via issues or pull requests.

# Installation

```
npm i -g https://github.com/keijokapp/score-util
```

Requirements:

 - Node 20 or later
 - MuseScore 4 (possibly also works with earlier versions)
 - ffmpeg and ffprobe

## `create-musescore-video`

**Usage:** `create-musescore-video [--audio=soprano=-13,alto=-13...] input.mscz output.mp4`

Creates a video file from MuseScore file. It does this by extracting SVG-s and playback synchronization info with `mscore --score-media`. It then creates frame images, each being an SVG with a cursor line drawn according to synchronization data. `--audio` option can be used to override volumes of individual instruments. Channel names are instrument ID-s as defined in the `audiosettings.json` in the MuseScore file.

## `score-util`

**Usage:** `score-util [--audio=part1/soprano=-13,alto=-13...]...

Given that the utility is run in a working directory with the following structure
```
 /path/to/some-score
 ├─ some-score.mscz
 ├─ some-irrelevant-other-score.mscz
 └─ audio
    └─ part2.wav
```

It generates the following files:
```
 /path/to/some-score
 ├─ audio
 │  └─ part1.wav                  -- an audio file exported according to `--audio` option
 └─ export
    ├─ some-score.mp4             -- scrolling video with original audio settings
    ├─ some-score (part1).mp4     --              ... from part1.wav
    └─ some-score (part2).mp4
```

The `--audio` option can be used to export audio from the MuseScore file. It can be used multiple times.

# License

ISC
