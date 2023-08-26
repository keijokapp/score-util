/* eslint-disable no-lonely-if,max-classes-per-file,no-bitwise,no-underscore-dangle */
import fs from 'fs';
import { Readable, Transform, PassThrough } from 'stream';
import zlib from 'zlib';
import crc32 from 'buffer-crc32';

const { unsigned: crc32Unsigned } = crc32;

const EMPTY_BUFFER = Buffer.allocUnsafe(0);

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const VERSION_NEEDED_TO_EXTRACT_UTF8 = 20;
const VERSION_NEEDED_TO_EXTRACT_ZIP64 = 45;
// 3 = unix. 63 = spec version 6.3
const VERSION_MADE_BY = (3 << 8) | 63;
const FILE_NAME_IS_UTF8 = 1 << 11;
const UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;

const eocdrSignatureBuffer = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

const ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE = 56;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE = 20;
const END_OF_CENTRAL_DIRECTORY_RECORD_SIZE = 22;

const DATA_DESCRIPTOR_SIZE = 16;
const ZIP64_DATA_DESCRIPTOR_SIZE = 24;

const CENTRAL_DIRECTORY_RECORD_FIXED_SIZE = 46;
const ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE = 28;

export default class ZipFile extends Readable {
	constructor() {
		super();
		this.entries = [];
		this.queue = Promise.resolve();
		this.outputStreamCursor = 0;
	}

	// eslint-disable-next-line class-methods-use-this
	_read() {}

	addFile(realPath, metadataPath, options = {}) {
		metadataPath = validateMetadataPath(metadataPath, false);

		const statsPromise = fs.promises.open(realPath)
			.then(async handle => [handle, await handle.stat()]);

		statsPromise.catch(() => {});

		return addEntry(this, async () => {
			const [handle, stats] = await statsPromise;

			if (!stats.isFile()) {
				throw new Error(`not a file: ${realPath}`);
			}

			const entry = new FileEntry(metadataPath, {
				forceZip64Format: false,
				...options,
				compress: options.compress ?? true,
				mode: options.mode ?? stats.mode,
				mtime: options.mtime ?? stats.mtime,
				size: stats.size
			});

			const readStream = handle.createReadStream();

			readStream.on('error', e => {
				this.emit('error', e);

				this.destroy();
			});

			return [
				entry,
				() => writeEntryStream(this, entry, readStream)
			];
		});
	}

	addReadStream(readStream, metadataPath, options = {}) {
		metadataPath = validateMetadataPath(metadataPath, false);

		const entry = new FileEntry(metadataPath, {
			...options,
			compress: options.compress ?? true
		});

		return addEntry(this, () => [entry, () => writeEntryStream(this, entry, readStream)]);
	}

	addBuffer(buffer, metadataPath, { compress = true, ...options } = {}) {
		metadataPath = validateMetadataPath(metadataPath, false);
		if (buffer.length > 0x3fffffff) throw new Error(`buffer too large: ${buffer.length} > ${0x3fffffff}`);

		const crc32 = crc32Unsigned(buffer);
		const size = buffer.length;

		if (compress) {
			buffer = new Promise((resolve, reject) => {
				zlib.deflateRaw(buffer, (err, compressedBuffer) => {
					if (err) {
						reject(err);

						return;
					}

					resolve(compressedBuffer);
				});
			});

			buffer.catch(() => {});
		}

		return addEntry(this, async () => {
			buffer = await buffer;

			const entry = new FileEntry(metadataPath, {
				...options,
				compress,
				compressedSize: buffer.length,
				crc32,
				size
			});

			return [
				entry,
				() => {
					writeBuffer(this, buffer);
					writeBuffer(this, getDataDescriptor(entry));
				}
			];
		});
	}

	addEmptyDirectory(metadataPath, options = {}) {
		metadataPath = validateMetadataPath(metadataPath, true);

		return addEntry(this, () => {
			const entry = new DirectoryEntry(metadataPath, options);

			return [
				entry,
				() => writeBuffer(this, getDataDescriptor(entry))
			];
		});
	}

	end(options = {}) {
		if (!this.queue) {
			throw new Error('Zip file has been finalized');
		}

		const forceZip64Format = !!options.forceZip64Format;
		let comment = EMPTY_BUFFER;

		if (options.comment != null) {
			comment = typeof options.comment === 'string'
				? encodeCp437(options.comment)
				: options.comment;

			if (comment.length > 0xffff) {
				throw new Error('comment is too large');
			}

			// gotta check for this, because the zipfile format is actually ambiguous.
			if (comment.includes(eocdrSignatureBuffer)) {
				throw new Error('comment contains end of central directory record signature');
			}
		}

		const queue = this.queue.then(() => {
			this.offsetOfStartOfCentralDirectory = this.outputStreamCursor;

			this.entries.forEach(entry => {
				writeBuffer(this, getCentralDirectoryRecord(entry));
			});

			writeBuffer(this, getEndOfCentralDirectoryRecord({
				offsetOfStartOfCentralDirectory: this.offsetOfStartOfCentralDirectory,
				forceZip64Format,
				comment,
				outputStreamCursor: this.outputStreamCursor,
				entriesCount: this.entries.length
			}));

			this.push(null);

			return this.outputStreamCursor;
		});

		delete this.queue;

		return queue;
	}
}

async function addEntry(self, callback) {
	if (!self.queue) {
		throw new Error('Zip file has been finalized');
	}

	self.queue = self.queue.then(async () => {
		const [entry, write] = await callback();

		self.entries.push(entry);

		entry.relativeOffsetOfLocalHeader = self.outputStreamCursor;
		writeBuffer(self, getLocalFileHeader(entry));

		await write();

		return entry;
	});

	return self.queue;
}

function writeBuffer(self, buffer) {
	self.push(buffer);
	self.outputStreamCursor += buffer.length;
}

function writeEntryStream(self, entry, readStream) {
	let uncompressedSizeCounter = 0;
	let compressedSizeCounter = 0;
	let crc32 = 0;

	const stream = readStream
		.pipe(new Transform({
			transform(chunk, encoding, cb) {
				crc32 = crc32Unsigned(chunk, crc32);
				cb(null, chunk);
			}
		}))
		.pipe(new Transform({
			transform(chunk, encoding, cb) {
				uncompressedSizeCounter += chunk.length;
				cb(null, chunk);
			}
		}))
		.pipe(entry.compress ? new zlib.DeflateRaw() : new PassThrough())
		.pipe(new Transform({
			transform(chunk, encoding, cb) {
				compressedSizeCounter += chunk.length;
				cb(null, chunk);
			}
		}));

	stream.on('data', data => {
		self.push(data);
	});

	return new Promise((resolve, reject) => {
		stream.on('end', () => {
			entry.crc32 = crc32;
			if (entry.uncompressedSize == null) {
				entry.uncompressedSize = uncompressedSizeCounter;
			} else if (entry.uncompressedSize !== uncompressedSizeCounter) {
				self.destroy();

				reject(new Error('file data stream has unexpected number of bytes'));

				return;
			}

			entry.compressedSize = compressedSizeCounter;
			self.outputStreamCursor += compressedSizeCounter;
			writeBuffer(self, getDataDescriptor(entry));

			resolve();
		});
	});
}

function getEndOfCentralDirectoryRecord({ entriesCount, outputStreamCursor, offsetOfStartOfCentralDirectory, comment, forceZip64Format }, actuallyJustTellMeHowLongItWouldBe) {
	let needZip64Format = false;
	let normalEntriesLength = entriesCount;
	if (forceZip64Format || entriesCount >= 0xffff) {
		normalEntriesLength = 0xffff;
		needZip64Format = true;
	}
	const sizeOfCentralDirectory = outputStreamCursor - offsetOfStartOfCentralDirectory;
	let normalSizeOfCentralDirectory = sizeOfCentralDirectory;
	if (forceZip64Format || sizeOfCentralDirectory >= 0xffffffff) {
		normalSizeOfCentralDirectory = 0xffffffff;
		needZip64Format = true;
	}
	let normalOffsetOfStartOfCentralDirectory = offsetOfStartOfCentralDirectory;
	if (forceZip64Format || offsetOfStartOfCentralDirectory >= 0xffffffff) {
		normalOffsetOfStartOfCentralDirectory = 0xffffffff;
		needZip64Format = true;
	}
	if (actuallyJustTellMeHowLongItWouldBe) {
		if (needZip64Format) {
			return (
				ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE
        + ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE
        + END_OF_CENTRAL_DIRECTORY_RECORD_SIZE
			);
		}

		return END_OF_CENTRAL_DIRECTORY_RECORD_SIZE;
	}

	const eocdrBuffer = Buffer.allocUnsafe(END_OF_CENTRAL_DIRECTORY_RECORD_SIZE + comment.length);
	// end of central dir signature                       4 bytes  (0x06054b50)
	eocdrBuffer.writeUInt32LE(0x06054b50, 0);
	// number of this disk                                2 bytes
	eocdrBuffer.writeUInt16LE(0, 4);
	// number of the disk with the start of the central directory  2 bytes
	eocdrBuffer.writeUInt16LE(0, 6);
	// total number of entries in the central directory on this disk  2 bytes
	eocdrBuffer.writeUInt16LE(normalEntriesLength, 8);
	// total number of entries in the central directory   2 bytes
	eocdrBuffer.writeUInt16LE(normalEntriesLength, 10);
	// size of the central directory                      4 bytes
	eocdrBuffer.writeUInt32LE(normalSizeOfCentralDirectory, 12);
	// offset of start of central directory with respect to the starting disk number  4 bytes
	eocdrBuffer.writeUInt32LE(normalOffsetOfStartOfCentralDirectory, 16);
	// .ZIP file comment length                           2 bytes
	eocdrBuffer.writeUInt16LE(comment.length, 20);
	// .ZIP file comment                                  (variable size)
	comment.copy(eocdrBuffer, 22);

	if (!needZip64Format) return eocdrBuffer;

	// ZIP64 format
	// ZIP64 End of Central Directory Record
	const zip64EocdrBuffer = Buffer.allocUnsafe(ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE);
	// zip64 end of central dir signature                                             4 bytes  (0x06064b50)
	zip64EocdrBuffer.writeUInt32LE(0x06064b50, 0);
	// size of zip64 end of central directory record                                  8 bytes
	writeUInt64LE(zip64EocdrBuffer, ZIP64_END_OF_CENTRAL_DIRECTORY_RECORD_SIZE - 12, 4);
	// version made by                                                                2 bytes
	zip64EocdrBuffer.writeUInt16LE(VERSION_MADE_BY, 12);
	// version needed to extract                                                      2 bytes
	zip64EocdrBuffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_ZIP64, 14);
	// number of this disk                                                            4 bytes
	zip64EocdrBuffer.writeUInt32LE(0, 16);
	// number of the disk with the start of the central directory                     4 bytes
	zip64EocdrBuffer.writeUInt32LE(0, 20);
	// total number of entries in the central directory on this disk                  8 bytes
	writeUInt64LE(zip64EocdrBuffer, entriesCount, 24);
	// total number of entries in the central directory                               8 bytes
	writeUInt64LE(zip64EocdrBuffer, entriesCount, 32);
	// size of the central directory                                                  8 bytes
	writeUInt64LE(zip64EocdrBuffer, sizeOfCentralDirectory, 40);
	// offset of start of central directory with respect to the starting disk number  8 bytes
	writeUInt64LE(zip64EocdrBuffer, offsetOfStartOfCentralDirectory, 48);
	// zip64 extensible data sector                                                   (variable size)
	// nothing in the zip64 extensible data sector

	// ZIP64 End of Central Directory Locator
	const zip64EocdlBuffer = Buffer.allocUnsafe(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIZE);
	// zip64 end of central dir locator signature                               4 bytes  (0x07064b50)
	zip64EocdlBuffer.writeUInt32LE(0x07064b50, 0);
	// number of the disk with the start of the zip64 end of central directory  4 bytes
	zip64EocdlBuffer.writeUInt32LE(0, 4);
	// relative offset of the zip64 end of central directory record             8 bytes
	writeUInt64LE(zip64EocdlBuffer, outputStreamCursor, 8);
	// total number of disks                                                    4 bytes
	zip64EocdlBuffer.writeUInt32LE(1, 16);

	return Buffer.concat([
		zip64EocdrBuffer,
		zip64EocdlBuffer,
		eocdrBuffer
	]);
}

function validateMetadataPath(metadataPath, isDirectory) {
	if (metadataPath === '') throw new Error('empty metadataPath');
	metadataPath = metadataPath.replace(/\\/g, '/');
	if (/^[a-zA-Z]:/.test(metadataPath) || /^\//.test(metadataPath)) throw new Error(`absolute path: ${metadataPath}`);
	if (metadataPath.split('/').indexOf('..') !== -1) throw new Error(`invalid relative path: ${metadataPath}`);
	const looksLikeDirectory = /\/$/.test(metadataPath);
	if (isDirectory) {
		// append a trailing '/' if necessary.
		if (!looksLikeDirectory) metadataPath += '/';
	} else if (looksLikeDirectory) throw new Error(`file path cannot end with '/': ${metadataPath}`);

	return metadataPath;
}

function getCentralDirectoryRecord(entry) {
	const fixedSizeStuff = Buffer.allocUnsafe(CENTRAL_DIRECTORY_RECORD_FIXED_SIZE);
	let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
	if (!entry.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

	let normalCompressedSize = entry.compressedSize;
	let normalUncompressedSize = entry.uncompressedSize;
	let normalRelativeOffsetOfLocalHeader = entry.relativeOffsetOfLocalHeader;
	let versionNeededToExtract;
	let zeiefBuffer;

	const useZip64Format = entry.forceZip64Format
		|| entry.uncompressedSize > 0xfffffffe
		|| entry.compressedSize > 0xfffffffe
		|| entry.relativeOffsetOfLocalHeader > 0xfffffffe;

	if (useZip64Format) {
		normalCompressedSize = 0xffffffff;
		normalUncompressedSize = 0xffffffff;
		normalRelativeOffsetOfLocalHeader = 0xffffffff;
		versionNeededToExtract = VERSION_NEEDED_TO_EXTRACT_ZIP64;

		// ZIP64 extended information extra field
		zeiefBuffer = Buffer.allocUnsafe(ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE);
		// 0x0001                  2 bytes    Tag for this "extra" block type
		zeiefBuffer.writeUInt16LE(0x0001, 0);
		// Size                    2 bytes    Size of this "extra" block
		zeiefBuffer.writeUInt16LE(ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_SIZE - 4, 2);
		// Original Size           8 bytes    Original uncompressed file size
		writeUInt64LE(zeiefBuffer, entry.uncompressedSize, 4);
		// Compressed Size         8 bytes    Size of compressed data
		writeUInt64LE(zeiefBuffer, entry.compressedSize, 12);
		// Relative Header Offset  8 bytes    Offset of local header record
		writeUInt64LE(zeiefBuffer, entry.relativeOffsetOfLocalHeader, 20);
		// Disk Start Number       4 bytes    Number of the disk on which this file starts
		// (omit)
	} else {
		versionNeededToExtract = VERSION_NEEDED_TO_EXTRACT_UTF8;
		zeiefBuffer = EMPTY_BUFFER;
	}

	// central file header signature   4 bytes  (0x02014b50)
	fixedSizeStuff.writeUInt32LE(0x02014b50, 0);
	// version made by                 2 bytes
	fixedSizeStuff.writeUInt16LE(VERSION_MADE_BY, 4);
	// version needed to extract       2 bytes
	fixedSizeStuff.writeUInt16LE(versionNeededToExtract, 6);
	// general purpose bit flag        2 bytes
	fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 8);
	// compression method              2 bytes

	fixedSizeStuff.writeUInt16LE(entry.compress ? 8 /* DEFLATE_COMPRESSION */ : 0 /* NO_COMPRESSION */, 10);
	// last mod file time              2 bytes
	fixedSizeStuff.writeUInt16LE(entry.lastModFileTime, 12);
	// last mod file date              2 bytes
	fixedSizeStuff.writeUInt16LE(entry.lastModFileDate, 14);
	// crc-32                          4 bytes
	fixedSizeStuff.writeUInt32LE(entry.crc32, 16);
	// compressed size                 4 bytes
	fixedSizeStuff.writeUInt32LE(normalCompressedSize, 20);
	// uncompressed size               4 bytes
	fixedSizeStuff.writeUInt32LE(normalUncompressedSize, 24);
	// file name length                2 bytes
	fixedSizeStuff.writeUInt16LE(entry.utf8FileName.length, 28);
	// extra field length              2 bytes
	fixedSizeStuff.writeUInt16LE(zeiefBuffer.length, 30);
	// file comment length             2 bytes
	fixedSizeStuff.writeUInt16LE(entry.fileComment.length, 32);
	// disk number start               2 bytes
	fixedSizeStuff.writeUInt16LE(0, 34);
	// internal file attributes        2 bytes
	fixedSizeStuff.writeUInt16LE(0, 36);
	// external file attributes        4 bytes
	fixedSizeStuff.writeUInt32LE(entry.externalFileAttributes, 38);
	// relative offset of local header 4 bytes
	fixedSizeStuff.writeUInt32LE(normalRelativeOffsetOfLocalHeader, 42);

	return Buffer.concat([
		fixedSizeStuff,
		// file name (variable size)
		entry.utf8FileName,
		// extra field (variable size)
		zeiefBuffer,
		// file comment (variable size)
		entry.fileComment
	]);
}

function getLocalFileHeader(entry) {
	let crc32 = 0;
	let compressedSize = 0;
	let uncompressedSize = 0;
	if (entry.crcAndFileSizeKnown) {
		crc32 = entry.crc32;
		compressedSize = entry.compressedSize;
		uncompressedSize = entry.uncompressedSize;
	}

	const fixedSizeStuff = Buffer.allocUnsafe(LOCAL_FILE_HEADER_FIXED_SIZE);
	let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
	if (!entry.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

	// local file header signature     4 bytes  (0x04034b50)
	fixedSizeStuff.writeUInt32LE(0x04034b50, 0);
	// version needed to extract       2 bytes
	fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_UTF8, 4);
	// general purpose bit flag        2 bytes
	fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 6);
	// compression method              2 bytes
	fixedSizeStuff.writeUInt16LE(entry.compress ? 8 /* DEFLATE_COMPRESSION */ : 0 /* NO_COMPRESSION */, 8);
	// last mod file time              2 bytes
	fixedSizeStuff.writeUInt16LE(entry.lastModFileTime, 10);
	// last mod file date              2 bytes
	fixedSizeStuff.writeUInt16LE(entry.lastModFileDate, 12);
	// crc-32                          4 bytes
	fixedSizeStuff.writeUInt32LE(crc32, 14);
	// compressed size                 4 bytes
	fixedSizeStuff.writeUInt32LE(compressedSize, 18);
	// uncompressed size               4 bytes
	fixedSizeStuff.writeUInt32LE(uncompressedSize, 22);
	// file name length                2 bytes
	fixedSizeStuff.writeUInt16LE(entry.utf8FileName.length, 26);
	// extra field length              2 bytes
	fixedSizeStuff.writeUInt16LE(0, 28);

	return Buffer.concat([
		fixedSizeStuff,
		// file name (variable size)
		entry.utf8FileName
		// extra field (variable size)
		// no extra fields
	]);
}

function getDataDescriptor(entry) {
	if (entry.crcAndFileSizeKnown) {
		// the Mac Archive Utility requires this not be present unless we set general purpose bit 3
		return EMPTY_BUFFER;
	}

	const useZip64Format = entry.forceZip64Format
		|| entry.uncompressedSize > 0xfffffffe
		|| entry.compressedSize > 0xfffffffe
		|| entry.relativeOffsetOfLocalHeader > 0xfffffffe;

	if (!useZip64Format) {
		const buffer = Buffer.allocUnsafe(DATA_DESCRIPTOR_SIZE);
		// optional signature (required according to Archive Utility)
		buffer.writeUInt32LE(0x08074b50, 0);
		// crc-32                          4 bytes
		buffer.writeUInt32LE(entry.crc32, 4);
		// compressed size                 4 bytes
		buffer.writeUInt32LE(entry.compressedSize, 8);
		// uncompressed size               4 bytes
		buffer.writeUInt32LE(entry.uncompressedSize, 12);

		return buffer;
	}

	// ZIP64 format
	const buffer = Buffer.allocUnsafe(ZIP64_DATA_DESCRIPTOR_SIZE);
	// optional signature (unknown if anyone cares about this)
	buffer.writeUInt32LE(0x08074b50, 0);
	// crc-32                          4 bytes
	buffer.writeUInt32LE(entry.crc32, 4);
	// compressed size                 8 bytes
	writeUInt64LE(buffer, entry.compressedSize, 8);
	// uncompressed size               8 bytes
	writeUInt64LE(buffer, entry.uncompressedSize, 16);

	return buffer;
}

// this class is not part of the public API
class Entry {
	constructor(metadataPath, options) {
		this.utf8FileName = Buffer.from(metadataPath);
		if (this.utf8FileName.length > 0xffff) throw new Error(`utf8 file name too long. ${this.utf8FileName.length} > ${0xffff}`);

		const dosDateTime = dateToDosDateTime(options.mtime ?? new Date());
		this.lastModFileTime = dosDateTime.time;
		this.lastModFileDate = dosDateTime.date;

		if ((options.mode & 0xffff) !== options.mode) {
			throw new Error(`invalid mode. expected: 0 <= ${options.mode} <= ${0xffff}`);
		}

		this.externalFileAttributes = (options.mode << 16) >>> 0;
		this.crc32 = options.crc32;
		this.uncompressedSize = options.size;
		this.compressedSize = options.compressedSize;
		this.compress = !!options.compress;
		this.crcAndFileSizeKnown = this.crc32 != null && this.uncompressedSize != null;
		this.forceZip64Format = !!options.forceZip64Format;
		this.fileComment = EMPTY_BUFFER;

		if (options.fileComment != null) {
			this.fileComment = typeof options.fileComment === 'string'
				? Buffer.from(options.fileComment, 'utf-8')
				: options.fileComment;

			if (this.fileComment.length > 0xffff) {
				throw new Error('File comment is too large');
			}
		}
	}
}

class DirectoryEntry extends Entry {
	constructor(metadataPath, options = {}) {
		super(metadataPath, {
			...options,
			mode: options.mode ?? 0o40775,
			crc32: 0,
			uncompressedSize: 0,
			compressedSize: 0,
			compress: false
		});
	}
}

class FileEntry extends Entry {
	constructor(metadataPath, options = {}) {
		super(metadataPath, {
			...options,
			mode: options.mode ?? 0o100664
		});
	}
}

function dateToDosDateTime(jsDate) {
	let date = 0;
	date |= jsDate.getDate() & 0x1f; // 1-31
	date |= ((jsDate.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
	date |= ((jsDate.getFullYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

	let time = 0;
	time |= Math.floor(jsDate.getSeconds() / 2); // 0-59, 0-29 (lose odd numbers)
	time |= (jsDate.getMinutes() & 0x3f) << 5; // 0-59
	time |= (jsDate.getHours() & 0x1f) << 11; // 0-23

	return { date, time };
}

function writeUInt64LE(buffer, n, offset) {
	// can't use bitshift here, because JavaScript only allows bitshifting on 32-bit integers.
	const high = Math.floor(n / 0x100000000);
	const low = n % 0x100000000;
	buffer.writeUInt32LE(low, offset);
	buffer.writeUInt32LE(high, offset + 4);
}

const cp437 = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
if (cp437.length !== 256) throw new Error('assertion failure');
let reverseCp437 = null;

function encodeCp437(string) {
	if (/^[\x20-\x7e]*$/.test(string)) {
		// CP437, ASCII, and UTF-8 overlap in this range.
		return Buffer.from(string, 'utf-8');
	}

	// This is the slow path.
	if (reverseCp437 == null) {
		// cache this once
		reverseCp437 = {};
		for (let i = 0; i < cp437.length; i++) {
			reverseCp437[cp437[i]] = i;
		}
	}

	const result = Buffer.allocUnsafe(string.length);
	for (let i = 0; i < string.length; i++) {
		const b = reverseCp437[string[i]];
		if (b == null) throw new Error(`character not encodable in CP437: ${JSON.stringify(string[i])}`);
		result[i] = b;
	}

	return result;
}
