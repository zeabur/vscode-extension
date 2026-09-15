import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectFiles, createZip } from '../packager';

interface Fixture {
	[relativePath: string]: string;
}

function makeProject(files: Fixture): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeabur-packager-test-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return dir;
}

/** Reads entry names from a zip's central directory (no external deps). */
function listZipEntries(zipPath: string): string[] {
	const buf = fs.readFileSync(zipPath);
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	assert.notEqual(eocd, -1, 'end of central directory not found');
	const entryCount = buf.readUInt16LE(eocd + 10);
	let offset = buf.readUInt32LE(eocd + 16);
	const names: string[] = [];
	for (let n = 0; n < entryCount; n++) {
		assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'central directory header expected');
		const nameLen = buf.readUInt16LE(offset + 28);
		const extraLen = buf.readUInt16LE(offset + 30);
		const commentLen = buf.readUInt16LE(offset + 32);
		names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
		offset += 46 + nameLen + extraLen + commentLen;
	}
	return names.sort();
}

test('excludes .env at the workspace root but keeps .env.example', async () => {
	const dir = makeProject({
		'index.js': 'console.log(1)',
		'.env': 'SECRET=1',
		'.env.example': 'SECRET=',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.files.sort(), ['.env.example', 'index.js']);
});

test('excludes .env variants and env files in nested directories', async () => {
	const dir = makeProject({
		'app.py': '',
		'.env.local': 'X=1',
		'.env.production': 'X=1',
		'services/api/.env': 'X=1',
		'services/api/main.py': '',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.files.sort(), ['app.py', 'services/api/main.py']);
});

test('excludes private keys and credential files at any depth', async () => {
	const dir = makeProject({
		'main.go': '',
		'id_rsa': 'PRIVATE',
		'id_ed25519.pub': 'PUBLIC',
		'certs/server.pem': 'PRIVATE',
		'certs/server.key': 'PRIVATE',
		'certs/keystore.jks': 'PRIVATE',
		'.npmrc': '//registry/:_authToken=abc',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.files.sort(), ['id_ed25519.pub', 'main.go']);
});

test('reports excluded sensitive files with their paths', async () => {
	const dir = makeProject({
		'main.go': '',
		'.env': 'X=1',
		'certs/server.pem': 'PRIVATE',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.sensitive.sort(), ['.env', 'certs/server.pem']);
});

test('honors a nested .gitignore relative to its own directory', async () => {
	const dir = makeProject({
		'README.md': '',
		'packages/web/.gitignore': 'build/\n*.log\n',
		'packages/web/src/index.ts': '',
		'packages/web/build/bundle.js': '',
		'packages/web/debug.log': '',
		'packages/api/build/keep.js': '',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.files.sort(), [
		'README.md',
		'packages/api/build/keep.js',
		'packages/web/.gitignore',
		'packages/web/src/index.ts',
	]);
});

test('applies root .gitignore and built-in directory ignores', async () => {
	const dir = makeProject({
		'.gitignore': 'dist/\n',
		'src/index.ts': '',
		'dist/index.js': '',
		'node_modules/pkg/index.js': '',
		'.git/HEAD': '',
		'.zeabur/project.zip': '',
		'venv/bin/python': '',
	});

	const result = await collectFiles(dir);

	assert.deepEqual(result.files.sort(), ['.gitignore', 'src/index.ts']);
});

test('createZip archives exactly the listed files', async () => {
	const dir = makeProject({
		'index.js': 'a',
		'lib/util.js': 'b',
		'.env': 'SECRET=1',
	});
	const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zeabur-zip-')), 'project.zip');

	await createZip(dir, ['index.js', 'lib/util.js'], zipPath);

	assert.deepEqual(listZipEntries(zipPath), ['index.js', 'lib/util.js']);
});
