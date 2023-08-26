/* eslint-disable max-classes-per-file,no-bitwise,no-underscore-dangle */
import fs from 'fs';
import zlib from 'zlib';
import { EventEmitter } from 'events';
import { Transform, pipeline } from 'stream';
import crc32 from 'buffer-crc32';
import fdSlicer from 'fd-slicer';

export async function open(path, options) {
	const fd = await new Promise((resolve, reject) => {
		fs.open(path, 'r', (err, fd) => {
			if (err) {
				reject(err);
			} else {
				resolve(fd);
			}
		});
	});

	try {
		return await fromFd(fd, options);
	} catch (e) {
		fs.close(fd, () => {});

		throw e;
	}
}

async function fromFd(fd, options) {
	const stats = await new Promise((resolve, reject) => {
		fs.fstat(fd, (e, stats) => {
			if (e) {
				reject(e);
			} else {
				resolve(stats);
			}
		});
	});

	const reader = fdSlicer.createFromFd(fd, { autoClose: true });

	return fromRandomAccessReader(reader, stats.size, options);
}

export function fromBuffer(buffer, options) {
	// limit the max chunk size. see https://github.com/thejoshwolfe/yauzl/issues/87
	const reader = fdSlicer.createFromBuffer(buffer, { maxChunkSize: 0x10000 });

	return fromRandomAccessReader(reader, buffer.length, options);
}

export async function fromRandomAccessReader(reader, totalSize, options = {}) {
	if (options.decodeStrings == null) options.decodeStrings = true;

	if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
		throw new Error('expected totalSize parameter to be a safe positive integer');
	}

	// the matching unref() call is in zipfile.close()
	reader.ref();

	try {
		// eocdr means End of Central Directory Record.
		// search backwards for the eocdr signature.
		// the last field of the eocdr is a variable-length comment.
		// the comment size is encoded in a 2-byte field in the eocdr, which we can't find without trudging backwards through the comment to find it.
		// as a consequence of this design decision, it's possible to have ambiguous zip file metadata if a coherent eocdr was in the comment.
		// we search backwards for a eocdr signature, and hope that whoever made the zip file was smart enough to forbid the eocdr signature in the comment.
		const eocdrWithoutCommentSize = 22;
		const maxCommentSize = 0xffff; // 2-byte size
		const bufferSize = Math.min(eocdrWithoutCommentSize + maxCommentSize, totalSize);
		const buffer = Buffer.allocUnsafe(bufferSize);
		const bufferReadStart = totalSize - buffer.length;

		await readAndAssertNoEof(reader, buffer, 0, bufferSize, bufferReadStart);

		for (let i = bufferSize - eocdrWithoutCommentSize; i >= 0; i -= 1) {
			if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
			// found eocdr
			const eocdrBuffer = buffer.subarray(i);

			// 0 - End of central directory signature = 0x06054b50
			// 4 - Number of this disk
			const diskNumber = eocdrBuffer.readUInt16LE(4);
			if (diskNumber !== 0) {
				throw new Error(`multi-disk zip files are not supported: found disk number: ${diskNumber}`);
			}

			// 6 - Disk where central directory starts
			// 8 - Number of central directory records on this disk
			// 10 - Total number of central directory records
			let entryCount = eocdrBuffer.readUInt16LE(10);
			// 12 - Size of central directory (bytes)
			// 16 - Offset of start of central directory, relative to start of archive
			let centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
			// 20 - Comment length
			const commentLength = eocdrBuffer.readUInt16LE(20);
			const expectedCommentLength = eocdrBuffer.length - eocdrWithoutCommentSize;

			if (commentLength !== expectedCommentLength) {
				throw new Error(`invalid comment length. expected: ${expectedCommentLength}. found: ${commentLength}`);
			}

			// 22 - Comment
			// the encoding is always cp437.
			const comment = options.decodeStrings
				? decodeBuffer(eocdrBuffer, 22, eocdrBuffer.length, false)
				: eocdrBuffer.subarray(22);

			if (!(entryCount === 0xffff || centralDirectoryOffset === 0xffffffff)) {
				return new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.autoClose, options.decodeStrings, options.validateEntrySizes, options.strictFileNames);
			}

			// ZIP64 format

			// ZIP64 Zip64 end of central directory locator
			const zip64EocdlBuffer = Buffer.allocUnsafe(20);
			const zip64EocdlOffset = bufferReadStart + i - zip64EocdlBuffer.length;

			await readAndAssertNoEof(reader, zip64EocdlBuffer, 0, zip64EocdlBuffer.length, zip64EocdlOffset);

			// 0 - zip64 end of central dir locator signature = 0x07064b50
			if (zip64EocdlBuffer.readUInt32LE(0) !== 0x07064b50) {
				throw new Error('invalid zip64 end of central directory locator signature');
			}
			// 4 - number of the disk with the start of the zip64 end of central directory
			// 8 - relative offset of the zip64 end of central directory record
			const zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);
			// 16 - total number of disks

			// ZIP64 end of central directory record
			const zip64EocdrBuffer = Buffer.allocUnsafe(56);

			await readAndAssertNoEof(reader, zip64EocdrBuffer, 0, zip64EocdrBuffer.length, zip64EocdrOffset);

			// 0 - zip64 end of central dir signature                           4 bytes  (0x06064b50)
			if (zip64EocdrBuffer.readUInt32LE(0) !== 0x06064b50) {
				throw new Error('invalid zip64 end of central directory record signature');
			}
			// 4 - size of zip64 end of central directory record                8 bytes
			// 12 - version made by                                             2 bytes
			// 14 - version needed to extract                                   2 bytes
			// 16 - number of this disk                                         4 bytes
			// 20 - number of the disk with the start of the central directory  4 bytes
			// 24 - total number of entries in the central directory on this disk         8 bytes
			// 32 - total number of entries in the central directory            8 bytes
			entryCount = readUInt64LE(zip64EocdrBuffer, 32);
			// 40 - size of the central directory                               8 bytes
			// 48 - offset of start of central directory with respect to the starting disk number     8 bytes
			centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
			// 56 - zip64 extensible data sector                                (variable size)

			return new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.decodeStrings, options.validateEntrySizes, options.strictFileNames);
		}

		throw new Error('end of central directory record signature not found');
	} finally {
		reader.unref();
	}
}

export class ZipFile extends EventEmitter {
	constructor(
		reader,
		centralDirectoryOffset,
		fileSize,
		entryCount,
		comment,
		decodeStrings = true,
		validateEntrySizes = true,
		strictFileNames = false
	) {
		super();

		reader.ref();
		this.reader = reader;

		// forward close events
		this.reader.on('error', e => {
			this.emit('error', e);

			if (this.isOpen) {
				this.isOpen = false;
				this.reader.unref();
			}
		});

		this.reader.once('close', () => {
			this.isOpen = false;
			this.emit('close');
		});

		this.centralDirectoryOffset = centralDirectoryOffset;
		this.fileSize = fileSize;
		this.entryCount = entryCount;
		this.comment = comment;
		this.decodeStrings = !!decodeStrings;
		this.validateEntrySizes = !!validateEntrySizes;
		this.strictFileNames = !!strictFileNames;
		this.isOpen = true;
	}

	async close() {
		if (this.isOpen) {
			this.isOpen = false;
			this.reader.unref();
		}
	}

	async* entries() {
		let cursor = this.centralDirectoryOffset;

		for (let entriesRead = 0; entriesRead < this.entryCount; entriesRead++) {
			if (!this.isOpen) {
				throw new Error('the instance is closed');
			}

			const entry = await readEntry(this.reader, cursor, this.decodeStrings, this.validateEntrySizes, this.strictFileNames);

			yield entry;

			cursor += entry.entrySize;
		}
	}

	async openReadStream(entry, options, callback) {
		if (!this.isOpen) {
			throw new Error('the instance is closed');
		}

		this.reader.ref();
		try {
			return await openReadStream(this, entry, options, callback);
		} finally {
			this.reader.unref();
		}
	}
}

async function readEntry(reader, cursor, decodeStrings, validateEntrySizes, strictFileNames) {
	const entryBuffer = Buffer.allocUnsafe(46);

	await readAndAssertNoEof(reader, entryBuffer, 0, entryBuffer.length, cursor);

	const entry = new Entry();
	// 0 - Central directory file header signature
	const signature = entryBuffer.readUInt32LE(0);
	if (signature !== 0x02014b50) {
		throw new Error(`invalid central directory file header signature: 0x${signature.toString(16)}`);
	}
	// 4 - Version made by
	entry.versionMadeBy = entryBuffer.readUInt16LE(4);
	// 6 - Version needed to extract (minimum)
	entry.versionNeededToExtract = entryBuffer.readUInt16LE(6);
	// 8 - General purpose bit flag
	entry.generalPurposeBitFlag = entryBuffer.readUInt16LE(8);
	// 10 - Compression method
	entry.compressionMethod = entryBuffer.readUInt16LE(10);
	// 12 - File last modification time
	entry.lastModFileTime = entryBuffer.readUInt16LE(12);
	// 14 - File last modification date
	entry.lastModFileDate = entryBuffer.readUInt16LE(14);
	// 16 - CRC-32
	entry.crc32 = entryBuffer.readUInt32LE(16);
	// 20 - Compressed size
	entry.compressedSize = entryBuffer.readUInt32LE(20);
	// 24 - Uncompressed size
	entry.uncompressedSize = entryBuffer.readUInt32LE(24);
	// 28 - File name length (n)
	entry.fileNameLength = entryBuffer.readUInt16LE(28);
	// 30 - Extra field length (m)
	entry.extraFieldLength = entryBuffer.readUInt16LE(30);
	// 32 - File comment length (k)
	entry.fileCommentLength = entryBuffer.readUInt16LE(32);
	// 34 - Disk number where file starts
	// 36 - Internal file attributes
	entry.internalFileAttributes = entryBuffer.readUInt16LE(36);
	// 38 - External file attributes
	entry.externalFileAttributes = entryBuffer.readUInt32LE(38);
	// 42 - Relative offset of local file header
	entry.relativeOffsetOfLocalHeader = entryBuffer.readUInt32LE(42);

	if (entry.generalPurposeBitFlag & 0x40) {
		throw new Error('strong encryption is not supported');
	}

	cursor += 46;

	const buffer = Buffer.allocUnsafe(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);

	entry.entrySize = 46 + buffer.length;

	await readAndAssertNoEof(reader, buffer, 0, buffer.length, cursor);

	// 46 - File name
	const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
	entry.fileName = decodeStrings
		? decodeBuffer(buffer, 0, entry.fileNameLength, isUtf8)
		: buffer.subarray(0, entry.fileNameLength);

	// 46+n - Extra field
	const fileCommentStart = entry.fileNameLength + entry.extraFieldLength;
	const extraFieldBuffer = buffer.subarray(entry.fileNameLength, fileCommentStart);
	entry.extraFields = [];
	for (let i = 0; i < extraFieldBuffer.length - 3;) {
		const headerId = extraFieldBuffer.readUInt16LE(i + 0);
		const dataSize = extraFieldBuffer.readUInt16LE(i + 2);
		const dataStart = i + 4;
		const dataEnd = dataStart + dataSize;

		if (dataEnd > extraFieldBuffer.length) {
			throw new Error('extra field length exceeds extra field buffer size');
		}

		const dataBuffer = Buffer.allocUnsafe(dataSize);
		extraFieldBuffer.copy(dataBuffer, 0, dataStart, dataEnd);

		entry.extraFields.push({
			id: headerId,
			data: dataBuffer
		});

		i = dataEnd;
	}

	// 46+n+m - File comment
	entry.fileComment = decodeStrings
		? decodeBuffer(buffer, fileCommentStart, fileCommentStart + entry.fileCommentLength, isUtf8)
		: buffer.subarray(fileCommentStart, fileCommentStart + entry.fileCommentLength);
	// compatibility hack for https://github.com/thejoshwolfe/yauzl/issues/47
	entry.comment = entry.fileComment;

	entry.entrySize = 46 + buffer.length;

	if (entry.uncompressedSize === 0xffffffff
			|| entry.compressedSize === 0xffffffff
			|| entry.relativeOffsetOfLocalHeader === 0xffffffff) {
		// ZIP64 format
		// find the Zip64 Extended Information Extra Field
		let zip64EiefBuffer = null;
		for (let i = 0; i < entry.extraFields.length; i++) {
			const extraField = entry.extraFields[i];
			if (extraField.id === 0x0001) {
				zip64EiefBuffer = extraField.data;
				break;
			}
		}
		if (zip64EiefBuffer == null) {
			throw new Error('expected zip64 extended information extra field');
		}
		let index = 0;
		// 0 - Original Size          8 bytes
		if (entry.uncompressedSize === 0xffffffff) {
			if (index + 8 > zip64EiefBuffer.length) {
				throw new Error('zip64 extended information extra field does not include uncompressed size');
			}
			entry.uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
			index += 8;
		}
		// 8 - Compressed Size        8 bytes
		if (entry.compressedSize === 0xffffffff) {
			if (index + 8 > zip64EiefBuffer.length) {
				throw new Error('zip64 extended information extra field does not include compressed size');
			}
			entry.compressedSize = readUInt64LE(zip64EiefBuffer, index);
			index += 8;
		}
		// 16 - Relative Header Offset 8 bytes
		if (entry.relativeOffsetOfLocalHeader === 0xffffffff) {
			if (index + 8 > zip64EiefBuffer.length) {
				throw new Error('zip64 extended information extra field does not include relative header offset');
			}
			entry.relativeOffsetOfLocalHeader = readUInt64LE(zip64EiefBuffer, index);
			index += 8;
		}
		// 24 - Disk Start Number      4 bytes
	}

	// check for Info-ZIP Unicode Path Extra Field (0x7075)
	// see https://github.com/thejoshwolfe/yauzl/issues/33
	if (decodeStrings) {
		for (let i = 0; i < entry.extraFields.length; i++) {
			const extraField = entry.extraFields[i];
			if (extraField.id === 0x7075) {
				if (extraField.data.length < 6) {
					// too short to be meaningful
					continue;
				}
				// Version       1 byte      version of this extra field, currently 1
				if (extraField.data.readUInt8(0) !== 1) {
					// > Changes may not be backward compatible so this extra
					// > field should not be used if the version is not recognized.
					continue;
				}
				// NameCRC32     4 bytes     File Name Field CRC32 Checksum
				const oldNameCrc32 = extraField.data.readUInt32LE(1);
				if (crc32.unsigned(buffer.subarray(0, entry.fileNameLength)) !== oldNameCrc32) {
					// > If the CRC check fails, this UTF-8 Path Extra Field should be
					// > ignored and the File Name field in the header should be used instead.
					continue;
				}
				// UnicodeName   Variable    UTF-8 version of the entry File Name
				entry.fileName = decodeBuffer(extraField.data, 5, extraField.data.length, true);
				break;
			}
		}
	}

	// validate file size
	if (validateEntrySizes && entry.compressionMethod === 0) {
		let expectedCompressedSize = entry.uncompressedSize;
		if (entry.isEncrypted()) {
			// traditional encryption prefixes the file data with a header
			expectedCompressedSize += 12;
		}
		if (entry.compressedSize !== expectedCompressedSize) {
			throw new Error(`compressed/uncompressed size mismatch for stored file: ${entry.compressedSize} != ${entry.uncompressedSize}`);
		}
	}

	if (decodeStrings) {
		if (!strictFileNames) {
			// allow backslash
			entry.fileName = entry.fileName.replace(/\\/g, '/');
		}
		const errorMessage = validateFileName(entry.fileName);
		if (errorMessage != null) throw new Error(errorMessage);
	}

	return entry;
}

async function openReadStream(self, entry, options = {}) {
	// parameter validation
	let relativeStart = 0;
	let relativeEnd = entry.compressedSize;
	// validate options that the caller has no excuse to get wrong
	if (options.decrypt != null) {
		if (!entry.isEncrypted()) {
			throw new Error('options.decrypt can only be specified for encrypted entries');
		}
		if (options.decrypt !== false) throw new Error(`invalid options.decrypt value: ${options.decrypt}`);
		if (entry.isCompressed()) {
			if (options.decompress !== false) throw new Error('entry is encrypted and compressed, and options.decompress !== false');
		}
	}
	if (options.decompress != null) {
		if (!entry.isCompressed()) {
			throw new Error('options.decompress can only be specified for compressed entries');
		}
		if (!(options.decompress === false || options.decompress === true)) {
			throw new Error(`invalid options.decompress value: ${options.decompress}`);
		}
	}
	if (options.start != null || options.end != null) {
		if (entry.isCompressed() && options.decompress !== false) {
			throw new Error('start/end range not allowed for compressed entry without options.decompress === false');
		}
		if (entry.isEncrypted() && options.decrypt !== false) {
			throw new Error('start/end range not allowed for encrypted entry without options.decrypt === false');
		}
	}
	if (options.start != null) {
		relativeStart = options.start;
		if (relativeStart < 0) throw new Error('options.start < 0');
		if (relativeStart > entry.compressedSize) throw new Error('options.start > entry.compressedSize');
	}
	if (options.end != null) {
		relativeEnd = options.end;
		if (relativeEnd < 0) throw new Error('options.end < 0');
		if (relativeEnd > entry.compressedSize) throw new Error('options.end > entry.compressedSize');
		if (relativeEnd < relativeStart) throw new Error('options.end < options.start');
	}

	if (entry.isEncrypted() && options.decrypt !== false) {
		throw new Error('entry is encrypted, and options.decrypt !== false');
	}

	const buffer = Buffer.allocUnsafe(30);

	await readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader);

	// 0 - Local file header signature = 0x04034b50
	const signature = buffer.readUInt32LE(0);
	if (signature !== 0x04034b50) {
		throw new Error(`invalid local file header signature: 0x${signature.toString(16)}`);
	}
	// all this should be redundant
	// 4 - Version needed to extract (minimum)
	// 6 - General purpose bit flag
	// 8 - Compression method
	// 10 - File last modification time
	// 12 - File last modification date
	// 14 - CRC-32
	// 18 - Compressed size
	// 22 - Uncompressed size
	// 26 - File name length (n)
	const fileNameLength = buffer.readUInt16LE(26);
	// 28 - Extra field length (m)
	const extraFieldLength = buffer.readUInt16LE(28);
	// 30 - File name
	// 30+n - Extra field
	const localFileHeaderEnd = entry.relativeOffsetOfLocalHeader + buffer.length + fileNameLength + extraFieldLength;
	let decompress;
	if (entry.compressionMethod === 0) {
		// 0 - The file is stored (no compression)
		decompress = false;
	} else if (entry.compressionMethod === 8) {
		// 8 - The file is Deflated
		decompress = options.decompress != null ? options.decompress : true;
	} else {
		throw new Error(`unsupported compression method: ${entry.compressionMethod}`);
	}
	const fileDataStart = localFileHeaderEnd;
	const fileDataEnd = fileDataStart + entry.compressedSize;
	if (entry.compressedSize !== 0) {
		// bounds check now, because the read streams will probably not complain loud enough.
		// since we're dealing with an unsigned offset plus an unsigned size,
		// we only have 1 thing to check for.
		if (fileDataEnd > self.fileSize) {
			throw new Error(`file data overflows file bounds: ${fileDataStart} + ${entry.compressedSize} > ${self.fileSize}`);
		}
	}

	let readStream = self.reader.createReadStream({
		start: fileDataStart + relativeStart,
		end: fileDataStart + relativeEnd
	});

	if (decompress) {
		const endpointStream = readStream;
		const inflateFilter = zlib.createInflateRaw();

		if (self.validateEntrySizes) {
			readStream = new AssertByteCountStream(entry.uncompressedSize);
			pipeline(endpointStream, inflateFilter, readStream, () => {});
		} else {
			readStream = inflateFilter;
			pipeline(endpointStream, readStream, () => {});
		}
	}

	return readStream;
}

export class Entry {
	getLastModDate() {
		return dosDateTimeToDate(this.lastModFileDate, this.lastModFileTime);
	}

	isEncrypted() {
		return (this.generalPurposeBitFlag & 0x1) !== 0;
	}

	isCompressed() {
		return this.compressionMethod === 8;
	}
}

export function dosDateTimeToDate(date, time) {
	const day = date & 0x1f; // 1-31
	const month = (date >> 5 & 0xf) - 1; // 1-12, 0-11
	const year = (date >> 9 & 0x7f) + 1980; // 0-128, 1980-2108

	const millisecond = 0;
	const second = (time & 0x1f) * 2; // 0-29, 0-58 (even numbers)
	const minute = time >> 5 & 0x3f; // 0-59
	const hour = time >> 11 & 0x1f; // 0-23

	return new Date(year, month, day, hour, minute, second, millisecond);
}

export function validateFileName(fileName) {
	if (fileName.indexOf('\\') !== -1) {
		return `invalid characters in fileName: ${fileName}`;
	}
	if (/^[a-zA-Z]:/.test(fileName) || /^\//.test(fileName)) {
		return `absolute path: ${fileName}`;
	}
	if (fileName.split('/').indexOf('..') !== -1) {
		return `invalid relative path: ${fileName}`;
	}
}

async function readAndAssertNoEof(reader, buffer, offset, length, position) {
	if (length === 0) {
		// fs.read will throw an out-of-bounds error if you try to read 0 bytes from a 0 byte file
		return;
	}

	const bytesRead = await new Promise((resolve, reject) => {
		reader.read(buffer, offset, length, position, (e, bytesRead) => {
			if (e) {
				reject(e);

				return;
			}

			resolve(bytesRead);
		});
	});

	if (bytesRead < length) {
		throw new Error('unexpected EOF');
	}
}

class AssertByteCountStream extends Transform {
	constructor(byteCount) {
		super();
		this.actualByteCount = 0;
		this.expectedByteCount = byteCount;
	}

	_transform(chunk, encoding, cb) {
		this.actualByteCount += chunk.length;
		if (this.actualByteCount > this.expectedByteCount) {
			const msg = `too many bytes in the stream. expected ${this.expectedByteCount}. got at least ${this.actualByteCount}`;

			return cb(new Error(msg));
		}
		cb(null, chunk);
	}

	_flush(cb) {
		if (this.actualByteCount < this.expectedByteCount) {
			const msg = `not enough bytes in the stream. expected ${this.expectedByteCount}. got only ${this.actualByteCount}`;

			return cb(new Error(msg));
		}
		cb();
	}
}

const cp437 = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeBuffer(buffer, start, end, isUtf8) {
	if (isUtf8) {
		return buffer.toString('utf8', start, end);
	}
	let result = '';
	for (let i = start; i < end; i++) {
		result += cp437[buffer[i]];
	}

	return result;
}

function readUInt64LE(buffer, offset) {
	// There is no native function for this, because we can't actually store 64-bit integers precisely.
	// After 53 bits, JavaScript's Number type (IEEE 754 double) can't store individual integers anymore.
	// But since 53 bits is a whole lot more than 32 bits, we do our best anyway.
	const lower32 = buffer.readUInt32LE(offset);
	const upper32 = buffer.readUInt32LE(offset + 4);

	// We can't use bitshifting here, because JavaScript bitshifting only works on 32-bit integers.
	// As long as we're bounds checking the result of this function against the total file size,
	// we'll catch any overflow errors, because we already made sure the total file size was within reason.
	return upper32 * 0x100000000 + lower32;
}
