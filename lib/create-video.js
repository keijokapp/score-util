// @ts-check

import assert from 'assert';
import { spawn } from 'child_process';
import chalk from 'chalk';
import * as xml from 'fast-xml-parser';
import { Resvg } from '@resvg/resvg-js';

/**
 * @param {import('./types.js').ScoreMedia} mediaInfo
 * @param {string | undefined} audioFile
 * @param {string} videoFile
 * @param {{ ffmpeg?: string | undefined }} [options]
 * @returns {Promise<void>}
 */
export default function createVideo(mediaInfo, audioFile, videoFile, { ffmpeg = 'ffmpeg' } = {}) {
	const svgs = mediaInfo.svgs.map(svg => parseSvg(svg));
	const keyframes = getKeyframes(mediaInfo);

	const frameRate = 60;

	let i = 0;

	/**
	 * @returns {{ width: number, height: number, pixels: unknown } | undefined}
	 */
	function getFrame() {
		const time = i++ / frameRate * 1000;

		const keyframeIndex = keyframes.findLastIndex(({ position }) => position <= time);

		if (keyframeIndex === -1 || keyframeIndex === keyframes.length - 1) {
			return;
		}

		const keyframe = keyframes[keyframeIndex];
		const nextKeyframe = keyframes[keyframeIndex + 1];
		const { system } = keyframe;

		assert.strictEqual(system, nextKeyframe.system);

		let svg = svgs[system.page];

		assert(!('line' in svg.svg[0]));
		assert(!('rect' in svg.svg[0]));

		const x = keyframe.x
			+ (time - keyframe.position)
			/ (nextKeyframe.position - keyframe.position)
			* (nextKeyframe.x - keyframe.x);

		console.log('Frame:%s Time:%s Keyframe:%s', chalk.bold(i), chalk.bold((time / 1000).toFixed(4)), chalk.bold(keyframeIndex));

		const viewBox = svgViewBox(svg);
		const viewWidth = viewBox.w;
		const viewHeight = viewBox.w * 9 / 16;

		const margin = 196;

		viewBox.h = Math.max(system.sy / 12 + 2 * margin, viewHeight);
		viewBox.y = system.sy / 12 + 2 * margin > viewHeight
			? system.y / 12 - margin
			: system.y / 12 + (system.sy / 12 - viewHeight) / 2 + 36;
		viewBox.w = viewBox.h * 16 / 9;
		viewBox.x = (viewWidth - viewBox.w) / 2;

		svg = {
			svg: [
				{
					rect: [{
						'@_x': `${viewBox.x}`,
						'@_y': `${viewBox.y}`,
						'@_width': `${viewBox.w}`,
						'@_height': `${viewBox.h}`,
						'@_fill': 'white'
					}],
					...svg.svg[0],
					'@_width': `${viewWidth}px`,
					'@_height': `${viewHeight}px`,
					'@_viewBox': `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`,
					line: [{
						'@_x1': x / 12,
						'@_y1': system.y / 12 - 55,
						'@_x2': x / 12,
						'@_y2': system.y / 12 + system.sy / 12 + 55,
						'@_stroke-width': 6,
						'@_stroke': '#45a0d1'
					}]
				}
			]
		};

		const resvg = new Resvg(buildSvg(svg));

		return resvg.render();
	}

	const { width, height, pixels } = /** @type {NonNullable<ReturnType<getFrame>>} */(getFrame());

	const proc = spawn(ffmpeg, [
		'-y',
		'-f', 'rawvideo',
		'-pix_fmt', 'rgba',
		'-s', `${width}x${height}`,
		'-r', `${frameRate}`,
		'-i', '-',
		...audioFile != null ? ['-i', audioFile, '-shortest'] : [],
		videoFile
	], { stdio: ['pipe', 'inherit', 'inherit'] });

	proc.stdin.on('drain', () => {
		let image;

		// eslint-disable-next-line no-cond-assign
		while (image = getFrame()) {
			assert.strictEqual(image.width, width);
			assert.strictEqual(image.height, height);

			if (!proc.stdin.write(image.pixels)) {
				return;
			}
		}

		proc.stdin.end();
	});

	proc.stdin.write(pixels);

	return new Promise((resolve, reject) => {
		proc.on('close', resolve);
		proc.on('error', reject);
	});
}

/**
 * @param {import('./types.js').ScoreMedia} mediaInfo
 * @returns {Array<{
 *   position: number
 *   x: number
 *   system: import('./types.js').ScoreElement
 * }>}
 */
function getKeyframes(mediaInfo) {
	const mpos = parsePosXml(mediaInfo.mposXML);
	const spos = parsePosXml(mediaInfo.sposXML);
	assert(mpos.every(
		({ position }) => spos.filter(({ position: position1 }) => position === position1).length === 1
	));

	const measures = mpos.map(({ position, element }, i) => ({
		start: position,
		end: mpos[i + 1] ? mpos[i + 1].position : mediaInfo.metadata.duration * 1000,
		// eslint-disable-next-line stylistic/max-len
		.../** @type {import('./types.js').ScoreElement & { system: import('./types.js').ScoreElement }} */(
			element
		)
	}));

	/**
	 * @type {Record<string, Array<
	 *   & import('./types.js').ScoreElement
	 *   & { system: import('./types.js').ScoreElement }
	 * >>}
	 */
	const systems = {};

	measures.forEach(measure => {
		const key = `${measure.page}:${measure.y}`;

		if (!(key in systems)) {
			systems[key] = [];
		}

		systems[key].push(measure);
	});

	Object.values(systems).forEach(measures => {
		assert(measures.every(({ sy }) => sy === measures[0].sy));

		const x = Math.min(...measures.map(({ x }) => x));
		const system = {
			page: measures[0].page,
			x,
			y: measures[0].y,
			sx: Math.max(...measures.map(({ x, sx }) => x + sx)) - x,
			sy: measures[0].sy
		};

		measures.forEach(measure => {
			measure.system = system;
		});
	});

	const keyframes = measures.flatMap(({
		start, end, x, sx, system
	}) => [
		...spos
			.filter(({ position }) => position >= start && position < end)
			.map(({ position, element: { x } }) => ({ position, x, system })),
		{
			position: end,
			x: x + sx,
			system
		}
	]);

	assert.strictEqual(keyframes.length, spos.length + mpos.length);
	assert(keyframes.slice(1).every(({ position }, i) => keyframes[i].position <= position));

	return keyframes;
}

/**
 * @param {any} sposXml
 * @returns {Array<{
 *   position: number
 *   element: import('./types.js').ScoreElement
 * }>}
 */
function parsePosXml(sposXml) {
	const { score: [score] } = new xml.XMLParser({
		parseTagValue: false,
		ignoreAttributes: false,
		parseAttributeValue: false,
		isArray: (_, __, ___, isAttribute) => !isAttribute
	})
		.parse(Buffer.from(sposXml, 'base64'));

	const { elements: [{ element: elements }], events: [{ event: events }] } = score;

	assert(elements.every(/** @param {any} element @param {number} i */(element, i) => element['@_id'] === `${i}`));

	return events.map(/** @param {any} event */event => ({
		position: +event['@_position'],
		element: {
			x: +elements[event['@_elid']]['@_x'],
			y: +elements[event['@_elid']]['@_y'],
			sx: +elements[event['@_elid']]['@_sx'],
			sy: +elements[event['@_elid']]['@_sy'],
			page: +elements[event['@_elid']]['@_page']
		}
	}));
}

/**
 * @param {string} svg
 * @returns {any}
 */
function parseSvg(svg) {
	const parsedXml = new xml.XMLParser({
		parseTagValue: false,
		ignoreAttributes: false,
		parseAttributeValue: false,
		isArray: (_, __, ___, isAttribute) => !isAttribute
	})
		.parse(Buffer.from(svg, 'base64'));

	return parsedXml;
}

/**
 * @param {any} svg
 * @returns {string}
 */
function buildSvg(svg) {
	return new xml.XMLBuilder({
		ignoreAttributes: false,
		format: true
	})
		.build(svg);
}

/**
 * @param {any} svg
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function svgViewBox(svg) {
	const [x, y, w, h] = svg.svg[0]['@_viewBox'].split(' ').map(/** @param {any} i */i => Number(i));
	assert.strictEqual(x, 0);
	assert.strictEqual(y, 0);
	assert.strictEqual(svg.svg[0]['@_width'], `${w}px`);
	assert.strictEqual(svg.svg[0]['@_height'], `${h}px`);

	return {
		x,
		y,
		w,
		h
	};
}
