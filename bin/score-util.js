#!/usr/bin/env node

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import module from 'module';
import util from 'util';
import path from 'path';
import chalk from 'chalk';
import createVideo from '../lib/create-video.js';
import modifyScore from '../lib/modify-score.js';
import {
	getAudioLength, parseChannels, scoreMedia, tmpfile
} from '../lib/utils.js';
import createAudio from '../lib/create-audio.js';

function getArgs() {
	try {
		return util.parseArgs({
			allowPositionals: true,
			options: {
				audio: {
					type: 'string',
					multiple: true,
					short: 'a'
				},
				ffmpeg: {
					type: 'string',
					default: 'ffmpeg'
				},
				ffprobe: {
					type: 'string',
					default: 'ffprobe'
				},
				help: {
					type: 'boolean',
					short: 'h'
				},
				mscore: {
					type: 'string',
					default: 'mscore'
				},
				version: {
					type: 'boolean',
					short: 'v'
				}
			}
		});
	} catch (/** @type {any} */e) {
		console.error(e.message);

		process.exit(1);
	}
}

function getVersion() {
	const require = module.createRequire(import.meta.url);

	return require('../package.json').version;
}

const args = getArgs();

if (args.values.version) {
	console.log(getVersion());

	process.exit(0);
}

if (args.values.help || args.positionals.length !== 0) {
	console.log(`Usage: score-util [--ffmpeg=ffmpeg] [--ffprobe=ffprobe] [--mscore=mscore] [--audio outputname/track1=0,track2=-13...]...

Options:
 -h,--help       show help text
 -v,--version    show version
 --ffmpeg=FILE   path to ffmpeg executable
 --ffprobe=FILE  path to ffprobe executable
 --mscore=FILE   path to MuseScore (mscore) executable
 -audio outputname/track1=0,track2=-13... export audio from score automatically with given configuration; can be specified multiple types
`);

	process.exit(args.values.help ? 0 : 1);
}

const newAudioFiles = args.values.audio != null
	? args.values.audio.map(arg => {
		const slashIndex = arg.indexOf('/');

		if (slashIndex === -1) {
			return [arg, {}];
		}

		const audioName = arg.slice(0, slashIndex);

		const channels = parseChannels(arg.slice(slashIndex + 1));

		if (channels.every(channel => channel != null)) {
			return /** @type {[string, Record<string, number>]} */(
				[audioName, Object.fromEntries(channels)]
			);
		}

		console.error('Invalid audio specifier: ', arg);

		process.exit(1);
	})
	: [];

const rootDirectory = path.resolve('.');
const audioDirectory = path.join(rootDirectory, 'audio');
const exportDirectory = path.join(rootDirectory, 'export');

const name = path.basename(rootDirectory);
const musescoreFile = path.join(rootDirectory, `${name}.mscz`);

const temporaryPrefix = await tmpfile();
const temporaryVideoFile = `${temporaryPrefix}.mp4`;
const temporaryScoreFile = `${temporaryPrefix}.mscz`;

if (newAudioFiles.length) {
	await fs.mkdir(audioDirectory).catch(e => {
		if (e.code !== 'EEXIST') {
			throw e;
		}
	});

	for (const [name, channels] of newAudioFiles) {
		const audioFile = path.join(audioDirectory, `${name}.wav`);

		console.log('Exporting audio: %s', chalk.bold(audioFile));

		await modifyScore(musescoreFile, temporaryScoreFile, channels);
		await createAudio(temporaryScoreFile, audioFile, { mscore: args.values.mscore });
	}
}

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

const lengths = await Promise.all(audioFiles.map(
	file => getAudioLength(path.join('audio', file), { ffprobe: args.values.ffprobe })
));
assert(lengths.every(length => length === lengths[0]));

console.log('Reconfiguring score %s for export', chalk.bold(path.basename(musescoreFile)));

await modifyScore(musescoreFile, temporaryScoreFile, {});

console.log('Loading score media');

const mediaInfo = await scoreMedia(temporaryScoreFile, { mscore: args.values.mscore });

console.log('Creating video');

await createVideo(mediaInfo, undefined, temporaryVideoFile, { ffmpeg: args.values.ffmpeg });

await fs.mkdir(exportDirectory).catch(e => {
	if (e.code !== 'EEXIST') {
		throw e;
	}
});

for (const audioFile of audioFiles) {
	const exportVideoFile = path.join(exportDirectory, `${audioFile.slice(0, -4) === name ? name : `${name} (${audioFile.slice(0, -4)})`}.mp4`);

	console.log('Creating video %s', chalk.bold(path.basename(exportVideoFile)));

	execFileSync(/** @type {string} */(args.values.ffmpeg), [
		'-y',
		'-i', temporaryVideoFile,
		'-i', path.join(audioDirectory, audioFile),
		'-c:v', 'copy', // video can be copied directly but MP4 does not support WAV audio
		'-shortest',
		exportVideoFile
	], { stdio: 'inherit' });
}
