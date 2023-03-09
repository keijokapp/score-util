import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import util from 'util';
import chalk from 'chalk';
import { rimraf, rimrafSync } from 'rimraf';

export async function getAudioLength(file) {
	const stdout = await new Promise((resolve, reject) => {
		execFile('ffprobe', [
			'-i', file,
			'-show_entries', 'format=duration',
			'-v', 'quiet',
			'-of', 'csv=p=0'
		], (e, stdout, stderr) => {
			if (e) {
				console.error(chalk.bold('Failed to get audio file length'), util.inspect({ file, stdout, stderr, e: e.message }, { depth: Infinity }));

				reject(e);
			} else {
				resolve(stdout);
			}
		});
	});

	return +stdout;
}

export async function scoreMedia(file) {
	const json = await new Promise((resolve, reject) => {
		execFile('mscore', ['--score-media', file], { maxBuffer: Infinity }, (e, stdout, stderr) => {
			if (e) {
				console.error(chalk.bold('Failed to get score media'), util.inspect({ file, stdout, stderr, e: e.message }, { depth: Infinity }));

				reject(e);
			} else {
				resolve(stdout);
			}
		});
	});

	return JSON.parse(json);
}

export async function withTemporaryDirectory(callback) {
	const bytes = await new Promise((resolve, reject) => {
		crypto.randomBytes(12, (e, bytes) => {
			if (e) {
				reject(e);
			} else {
				resolve(bytes);
			}
		});
	});

	const tmpdir = path.join(await fs.realpath(os.tmpdir()), `score-util-${bytes.toString('hex')}`);

	function remove() {
		rimrafSync(tmpdir);
	}

	process.on('exit', remove);

	await fs.mkdir(tmpdir);

	try {
		return await callback(tmpdir);
	} finally {
		await rimraf(tmpdir);
		process.removeListener('exit', remove);
	}
}
