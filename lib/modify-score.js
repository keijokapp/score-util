// @ts-check

import assert from 'node:assert';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
// eslint-disable-next-line import/no-unresolved
import Zip from '@arbendium/zip/zip';
// eslint-disable-next-line import/no-unresolved
import { fromFileHandle } from '@arbendium/zip/unzip';
import {
	parseXml, XmlDocument, XmlElement, XmlText
} from '@rgrove/parse-xml';

/**
 * @param {import('node:stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
function readStream(stream) {
	/** @type {Buffer[]} */
	const buffers = [];

	stream.on('data', data => buffers.push(data));

	return new Promise((resolve, reject) => {
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(buffers)));
	});
}

/**
 * @param {import('@rgrove/parse-xml').XmlNode} xml
 * @param {number} [indentationLevel]
 * @return {string}
 */
function serializeXml(xml, indentationLevel = 0) {
	if (xml instanceof XmlDocument) {
		return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(xml.children[0])}`;
	}

	if (xml instanceof XmlText) {
		return escapeXml(xml.text);
	}

	if (xml instanceof XmlElement) {
		const padding = '  '.repeat(indentationLevel);
		const children = xml.children.map(el => serializeXml(el, indentationLevel + 1)).filter(el => el.trim() !== '');
		const attributes = Object.entries(xml.attributes).map(([name, value]) => ` ${escapeXml(name)}="${escapeXml(value)}"`).join('');

		const name = escapeXml(xml.name);

		// eslint-disable-next-line no-nested-ternary
		return children.length === 0
			? `<${name}${attributes}/>`
			: (xml.children.every(child => !(child instanceof XmlText) || child.text.length === 0) && children.length > 1) || children.some(child => child.includes('\n'))
				? `<${name}${attributes}>${children.map(child => `\n  ${padding}${child}`).join('')}\n${padding}</${name}>`
				: `<${name}${attributes}>${children.join('')}</${name}>`;
	}

	return '<!-- unknown -->';
}

/**
 * @param {Buffer} xml
 * @param {(
 *   document: import('@rgrove/parse-xml').XmlDocument
 * ) => import('@rgrove/parse-xml').XmlDocument} callback
 * @returns {Buffer}
 */
function modifyXml(xml, callback) {
	return Buffer.from(serializeXml(callback(parseXml(xml.toString()))));
}

/**
 * @param {string} unsafe
 * @returns {string}
 */
function escapeXml(unsafe) {
	return unsafe.replace(/[<>&'"]/g, c => {
		switch (c) {
		case '<': return '&lt;';
		case '>': return '&gt;';
		case '&': return '&amp;';
		case '\'': return '&apos;';
		case '"': return '&quot;';
		default: return c;
		}
	});
}

/**
 * @param {string} scoreFile
 * @param {string} outputFile
 * @param {Record<string, number>} channels
 * @returns {Promise<string>}
 */
export default async function modifyScore(scoreFile, outputFile, channels) {
	const fileHandle = await fs.open(scoreFile);

	const sourceZip = await fromFileHandle(fileHandle);

	const destinazionZip = new Zip();

	const promise = pipeline(destinazionZip, createWriteStream(outputFile));

	for await (const [entry, createReadStream] of sourceZip.entries()) {
		// eslint-disable-next-line prefer-destructuring
		const fileName = /** @type {string} */(entry.fileName);

		switch (true) {
		case fileName === 'audiosettings.json': {
			const json = JSON.parse(/** @type {any} */(await readStream(await createReadStream())));

			for (const track of json.tracks) {
				if (channels[track.partId] != null) {
					track.out.volumeDb = channels[track.partId];
				}
			}

			destinazionZip.addBuffer(Buffer.from(JSON.stringify(json, null, 4)), 'audiosettings.json');

			break;
		}

		case fileName === 'score_style.mss':
			destinazionZip.addBuffer(
				modifyXml(await readStream(await createReadStream()), document => {
					/** @type {Record<string, string>} */
					const values = {
						enableVerticalSpread: '0',
						maxSystemDistance: `${4096}`,
						minSystemDistance: `${4096}`,
						showFooter: '0',
						showHeader: '0'
					};

					for (const child1 of document.children) {
						assert(child1 instanceof XmlElement && child1.name === 'museScore');

						for (const child2 of child1.children) {
							if (child2 instanceof XmlElement && child2.name === 'Style') {
								for (const child3 of child2.children) {
									if (child3 instanceof XmlElement && child3.name in values) {
										child3.children = [new XmlText(values[child3.name])];
									}
								}
							}
						}
					}

					return document;
				}),
				'score_style.mss'
			);

			break;
		case fileName.endsWith('.mscx'):
			destinazionZip.addBuffer(
				modifyXml(await readStream(await createReadStream()), document => {
					for (const child1 of document.children) {
						assert(child1 instanceof XmlElement && child1.name === 'museScore');

						for (const child2 of child1.children) {
							if (child2 instanceof XmlElement && child2.name === 'Score') {
								for (const child3 of child2.children) {
									if (child3 instanceof XmlElement && child3.name === 'Staff') {
										child3.children = child3.children.filter(child => !(child instanceof XmlElement) || child.name !== 'VBox');
									}
								}
							}
						}
					}

					return document;
				}),
				fileName
			);

			break;
		default:
			destinazionZip.addEntry(entry, createReadStream);
		}
	}

	destinazionZip.addCentralDirectoryRecord();
	destinazionZip.end();

	await promise;

	fileHandle.close();

	return outputFile;
}
