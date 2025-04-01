import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import util from 'util';
import chalk from 'chalk';

/**
 * @param {string} file
 * @param {{ ffprobe?: string | undefined }} [options]
 * @returns {Promise<number>}
 */
export async function getAudioLength(file, { ffprobe = 'ffprobe' } = {}) {
	const stdout = await new Promise((resolve, reject) => {
		execFile(ffprobe, [
			'-i', file,
			'-show_entries', 'format=duration',
			'-v', 'quiet',
			'-of', 'csv=p=0'
		], (e, stdout, stderr) => {
			if (e) {
				console.error(
					chalk.bold('Failed to get audio file length'),
					util.inspect(
						{
							file,
							stdout,
							stderr,
							e: e.message
						},
						{ depth: Infinity }
					)
				);

				reject(e);
			} else {
				resolve(stdout);
			}
		});
	});

	return +stdout;
}

/**
 * @param {string} file
 * @param {{ mscore?: string | undefined }} options
 * @returns {Promise<import('./types.js').ScoreMedia>}
 */
export async function scoreMedia(file, { mscore = 'mscore' } = {}) {
	const bytes = await new Promise((resolve, reject) => {
		crypto.randomBytes(12, (e, bytes) => {
			if (e) {
				reject(e);
			} else {
				resolve(bytes);
			}
		});
	});

	const outputFile = path.join(await fs.realpath(os.tmpdir()), `score-util-${bytes.toString('hex')}.json`);

	await new Promise((resolve, reject) => {
		execFile(mscore, ['-o', outputFile, '--score-media', file], (e, stdout, stderr) => {
			if (e) {
				console.error(
					chalk.bold('Failed to get score media'),
					util.inspect(
						{
							file,
							stdout,
							stderr,
							e: e.message
						},
						{ depth: Infinity }
					)
				);

				reject(e);
			} else {
				resolve(undefined);
			}
		});
	});

	return JSON.parse(await fs.readFile(outputFile, 'utf8'));
}

/**
 * @returns {Promise<string>}
 */
export async function tmpfile() {
	const bytes = await new Promise((resolve, reject) => {
		crypto.randomBytes(12, (e, bytes) => {
			if (e) {
				reject(e);
			} else {
				resolve(bytes);
			}
		});
	});

	return path.join(await fs.realpath(os.tmpdir()), `score-util-${bytes.toString('hex')}`);
}

/**
 * @param {string} channels
 * @returns {Array<undefined | [string, number]>}
 */
export function parseChannels(channels) {
	if (channels.length === 0) {
		return [];
	}

	return channels.split(',').map(channel => {
		const eqIndex = channel.indexOf('=');

		if (eqIndex !== -1) {
			const channelName = channel.slice(0, eqIndex);

			const volume = +channel.slice(eqIndex + 1).trim();

			if (Number.isFinite(volume)) {
				return /** @type {[string, number]} */([channelName, volume]);
			}
		}
	});
}
