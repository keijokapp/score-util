**This package exports 2 scripts:**

 - `create-musescore-video` - an opinionated utility to generate videos from MuseScore files
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

**Usage:** `create-musescore-video input.mscz output.mp4`

Creates a video file from MuseScore file. It does this by extracting SVG-s and playback synchronization info with `mscore --score-media`. It then creates frame images, each being an SVG with a cursor line drawn according to synchronization data.

**Limitations:**
 - **The generated video does not have audio**. MuseScore does not support exporting audio using Muse Sounds via CLI. Audio could be manually exported and added to the video separately. Eg: `ffmpeg -i silent-video.mp4 -i audio.wav -c:v copy -shortest video-with-audio.mp4` (`-shortest` is there because the audio exported from MuseScore is unnecessarily about 2 seconds longer than the playback)
 - Encoding SVG-s to video is quite slow (tested to be <1x).

## `score-util`

**Usage:** `score-util`

Given that the utility is run in a working directory with the following structure
```
 /path/to/some-score
 ├─ some-score.mscz
 ├─ some-irrelevant-other-score.mscz
 └─ audio
    ├─ some-score.wav
    ├─ part1.wav
    └─ part2.wav
```

It generates the following files:
```
 /path/to/some-score
 ├─ some-score.mp4                -- video without audio
 └─ export
    ├─ some-score.mp4             -- video with audio from some-score.wav
    ├─ some-score (part1).mp4     --              ... from part1.wav
    └─ some-score (part2).mp4
```

# License

ISC
