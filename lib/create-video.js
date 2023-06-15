import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import xml from 'fast-xml-parser';
import { withTemporaryDirectory } from './utils.js';

export default async function createVideo(mediaInfo, videoFile) {
	const svgs = mediaInfo.svgs.map(svg => parseSvg(svg));
	const keyframes = getKeyframes(mediaInfo);

	const frameRate = 60;

	await withTemporaryDirectory(async framesDirectory => {
		for (let i = 0; ; i++) {
			const time = i / frameRate * 1000;

			const keyframeIndex = keyframes.findLastIndex(({ position }) => position <= time);

			if (keyframeIndex === -1 || keyframeIndex === keyframes.length - 1) {
				break;
			}

			const keyframe = keyframes[keyframeIndex];
			const nextKeyframe = keyframes[keyframeIndex + 1];
			const { system } = keyframe;

			assert.strictEqual(system, nextKeyframe.system);

			let svg = svgs[system.page];

			assert(!('line' in svg.svg[0]));
			assert(!('rect' in svg.svg[0]));

			const x = keyframe.x + (time - keyframe.position) / (nextKeyframe.position - keyframe.position) * (nextKeyframe.x - keyframe.x);

			console.log('Frame:%s Time:%s Keyframe:%s', chalk.bold(i), chalk.bold((time / 1000).toFixed(4)), chalk.bold(keyframeIndex));

			const viewBox = svgViewBox(svg);
			const viewWidth = viewBox.w;
			const viewHeight = viewBox.w * 9 / 16;
			const yOffset = keyframe.system.y / 12 + (keyframe.system.sy / 12 - viewHeight) / 2 + 80;

			svg = {
				svg: [
					{
						rect: [{
							'@_x': '0',
							'@_y': `${yOffset}`,
							'@_width': `${viewWidth}`,
							'@_height': `${viewHeight}`,
							'@_fill': 'white'
						}],
						...svg.svg[0],
						'@_width': `${viewWidth}px`,
						'@_height': `${viewHeight}px`,
						'@_viewBox': `0 ${yOffset} ${viewWidth} ${viewHeight}`,
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

			await fs.writeFile(path.join(framesDirectory, `${String(i).padStart(6, '0')}.svg`), buildSvg(svg));
		}

		execFileSync('ffmpeg', [
			'-y',
			'-framerate', frameRate,
			'-i', '%06d.svg',
			path.resolve(videoFile)
		], { cwd: framesDirectory, stdio: 'inherit' });
	});
}

function getKeyframes(mediaInfo) {
	const mpos = parsePosXml(mediaInfo.mposXML);
	const spos = parsePosXml(mediaInfo.sposXML);
	assert(mpos.every(({ position }) => spos.filter(({ position: position1 }) => position === position1).length === 1));

	const measures = mpos.map(({ position, element }, i) => ({
		start: position,
		end: mpos[i + 1] ? mpos[i + 1].position : mediaInfo.metadata.duration * 1000,
		...element
	}));

	const keyframes = [...new Set(measures.map(({ page }) => page))].flatMap(page => {
		const pageMeasures = measures.filter(measure => page === measure.page);

		return [...new Set(pageMeasures.map(({ y }) => y))].flatMap(position => {
			const measures = pageMeasures.filter(({ y }) => y === position);

			assert(measures.every(({ sy }) => sy === measures[0].sy));

			const x = Math.min(...measures.map(({ x }) => x));
			const y = Math.min(...measures.map(({ y }) => y));

			const system = {
				page,
				x,
				y,
				sx: Math.max(...measures.map(({ x, sx }) => x + sx)) - x,
				sy: Math.max(...measures.map(({ y, sy }) => y + sy)) - y
			};

			return measures.flatMap(({ start, end, x, sx }) => [
				...spos
					.filter(({ position }) => position >= start && position < end)
					.map(({ position, element: { x } }) => ({ position, x, system })),
				{
					position: end,
					x: x + sx,
					system
				}
			]);
		});
	});

	assert.strictEqual(keyframes.length, spos.length + mpos.length);
	assert(keyframes.slice(1).every(({ position }, i) => keyframes[i].position <= position));

	return keyframes;
}

function parsePosXml(sposXml) {
	const { score: [score] } = new xml.XMLParser({
		parseTagValue: false,
		ignoreAttributes: false,
		parseAttributeValue: false,
		isArray: (_, __, ___, isAttribute) => !isAttribute
	})
		.parse(Buffer.from(sposXml, 'base64'));

	const { elements: [{ element: elements }], events: [{ event: events }] } = score;

	assert.strictEqual(elements.length, events.length);

	return events.map((event, i) => ({
		position: +event['@_position'],
		element: {
			x: +elements[i]['@_x'],
			y: +elements[i]['@_y'],
			sx: +elements[i]['@_sx'],
			sy: +elements[i]['@_sy'],
			page: +elements[i]['@_page']
		}
	}));
}

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

function buildSvg(svg) {
	return new xml.XMLBuilder({
		ignoreAttributes: false,
		format: true
	})
		.build(svg);
}

function svgViewBox(svg) {
	const [x, y, w, h] = svg.svg[0]['@_viewBox'].split(' ').map(i => Number(i));
	assert.strictEqual(x, 0);
	assert.strictEqual(y, 0);
	assert.strictEqual(svg.svg[0]['@_width'], `${w}px`);
	assert.strictEqual(svg.svg[0]['@_height'], `${h}px`);

	return { x, y, w, h };
}
