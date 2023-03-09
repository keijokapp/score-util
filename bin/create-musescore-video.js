#!/usr/bin/env node

import chalk from 'chalk';
import { scoreMedia } from '../lib/utils.js';
import createVideo from '../lib/create-video.js';

if (process.argv.length !== 4) {
	console.error('Usage: create-musescore-video input.mscz output.mp4');
	process.exit(1);
}

const [, , musescoreFile, videoFile] = process.argv;

console.log('Loading score media for %s', chalk.bold(musescoreFile));
const mediaInfo = await scoreMedia(musescoreFile);

await createVideo(mediaInfo, videoFile);
