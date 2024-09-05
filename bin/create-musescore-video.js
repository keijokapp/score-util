#!/usr/bin/env node

// @ts-check

import module from 'module';
import util from 'util';
import chalk from 'chalk';
import { scoreMedia } from '../lib/utils.js';
import createVideo from '../lib/create-video.js';

function getArgs() {
	try {
		return util.parseArgs({
			allowPositionals: true,
			options: {
				ffmpeg: {
					type: 'string',
					default: 'ffmpeg'
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

if (args.values.help || args.positionals.length !== 2) {
	console.log(`Usage: create-musescore-video [--ffmpeg=ffmpeg] [--mscore=mscore] input.mscz output.mp4

Options:
 -h,--help       show help text
 -v,--version    show version
 --ffmpeg=FILE   path to ffmpeg executable
 --mscore=FILE   path to MuseScore (mscore) executable
`);

	process.exit(args.values.help ? 0 : 1);
}

const [musescoreFile, videoFile] = args.positionals;

console.log('Loading score media for %s', chalk.bold(musescoreFile));
const mediaInfo = await scoreMedia(musescoreFile, { mscore: args.values.mscore });

await createVideo(mediaInfo, videoFile, { ffmpeg: args.values.ffmpeg });
