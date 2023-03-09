#!/usr/bin/env node

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import createVideo from '../lib/create-video.js';
import { getAudioLength, scoreMedia } from '../lib/utils.js';

const rootDirectory = path.resolve('.');
const audioDirectory = path.join(rootDirectory, 'audio');
const exportDirectory = path.join(rootDirectory, 'export');

const name = path.basename(rootDirectory);
const musescoreFile = path.join(rootDirectory, `${name}.mscz`);
const videoFile = path.join(rootDirectory, `${name}.mp4`);
const pdfFile = path.join(rootDirectory, `${name}.pdf`);

const audioFiles = await fs.readdir(audioDirectory).catch(e => {
	if (e.code === 'ENOENT') {
		return [];
	}

	throw e;
});

if (audioFiles.length === 0) {
	console.warn('No audio files');
	process.exit(1);
}

const lengths = await Promise.all(audioFiles.map(file => getAudioLength(`audio/${file}`)));
assert(lengths.every(length => length === lengths[0]));

console.log('Loading score media for %s', chalk.bold(path.basename(musescoreFile)));
const mediaInfo = await scoreMedia(musescoreFile);

console.log('Creating PDF %s', chalk.bold(path.basename(pdfFile)));
await fs.writeFile(pdfFile, Buffer.from(mediaInfo.pdf, 'base64'));

console.log('Creating video %s', chalk.bold(path.basename(videoFile)));
await createVideo(mediaInfo, videoFile);

await fs.mkdir(exportDirectory).catch(e => {
	if (e.code !== 'EEXIST') {
		throw e;
	}
});

for (const audioFile of audioFiles) {
	const exportVideoFile = path.join(exportDirectory, `${audioFile.slice(0, -4) === name ? name : `${name} (${audioFile.slice(0, -4)})`}.mp4`);

	console.log('Creating video %s', chalk.bold(path.basename(exportVideoFile)));

	execFileSync('ffmpeg', [
		'-y',
		'-i', videoFile,
		'-i', path.join(audioDirectory, audioFile),
		'-c:v', 'copy', // video can be copied directly but MP4 does not support WAV audio
		'-shortest',
		exportVideoFile
	], { stdio: 'inherit' });
}
