// @ts-check

import { execFile } from 'child_process';
import util from 'util';
import chalk from 'chalk';

/**
 * @param {string} scoreFile
 * @param {string} audioFile
 * @param {{ mscore?: string | undefined }} options
 * @returns {Promise<string>}
 */
export default async function createAudio(scoreFile, audioFile, { mscore = 'mscore' } = {}) {
	await new Promise((resolve, reject) => {
		execFile(mscore, ['-o', audioFile, scoreFile], (e, stdout, stderr) => {
			if (e) {
				console.error(
					chalk.bold('Failed to get score audio'),
					util.inspect(
						{
							file: scoreFile,
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

	return audioFile;
}
