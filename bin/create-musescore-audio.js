#!/usr/bin/env node

import module from 'module';
import util from 'util';
import modifyScore from '../lib/modify-score.js';
import { parseChannels, tmpfile } from '../lib/utils.js';
import createAudio from '../lib/create-audio.js';

function getArgs() {
	try {
		return util.parseArgs({
			allowPositionals: true,
			options: {
				audio: {
					type: 'string'
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
	console.log(`Usage: create-musescore-audio [--mscore=mscore] [--audio=track1=volume1,track2=volume2...] input.mscz output.wav

Options:
 -h,--help       show help text
 -v,--version    show version
 --mscore=FILE   path to MuseScore (mscore) executable
 --audio=channels audio channel volumes in a format 'track1=volume1,track2=volume2...'
`);

	process.exit(args.values.help ? 0 : 1);
}

/** @type {Record<string, number> | undefined} */
let audio;

if (args.values.audio != null) {
	const channels = parseChannels(args.values.audio);

	if (channels.every(channel => channel != null)) {
		audio = Object.fromEntries(channels);
	} else {
		console.error('Invalid audio specifier: ', args.values.audio);

		process.exit(1);
	}
}

const [musescoreFile, audioFile] = args.positionals;

const temporaryPrefix = await tmpfile();
const temporaryScoreFile = `${temporaryPrefix}.mscz`;

await modifyScore(musescoreFile, temporaryScoreFile, audio ?? {});
await createAudio(temporaryScoreFile, audioFile, { mscore: args.values.mscore });
