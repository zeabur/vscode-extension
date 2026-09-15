import fs from 'fs';
import path from 'path';
import { readdir } from 'fs/promises';
import archiver from 'archiver';
import ignore, { Ignore } from 'ignore';

/** Directories that are never uploaded, regardless of .gitignore. */
export const DEFAULT_IGNORES = [
	'node_modules/',
	'.git/',
	'.zeabur/',
	'venv/',
	'env/',
	'.*/',
];

/**
 * Files that commonly hold secrets. They are excluded at any depth even when
 * the workspace has no .gitignore. Negated entries re-include harmless
 * templates that projects usually commit on purpose.
 */
export const SENSITIVE_PATTERNS = [
	'.env',
	'.env.*',
	'!.env.example',
	'!.env.sample',
	'!.env.template',
	'*.pem',
	'*.key',
	'*.p12',
	'*.pfx',
	'*.jks',
	'*.keystore',
	'*.ppk',
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'.npmrc',
	'.yarnrc',
	'.pypirc',
	'.netrc',
	'.htpasswd',
];

export interface CollectResult {
	/** Workspace-relative POSIX paths that will be uploaded. */
	files: string[];
	/** Workspace-relative POSIX paths skipped because they matched SENSITIVE_PATTERNS. */
	sensitive: string[];
}

interface IgnoreScope {
	/** Workspace-relative POSIX directory the .gitignore lives in ('' for root). */
	base: string;
	ig: Ignore;
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

function relativeTo(base: string, target: string): string {
	return base === '' ? target : target.slice(base.length + 1);
}

/**
 * Mirrors git precedence: the deepest .gitignore that has an opinion wins,
 * so a nested `!keep.log` can re-include a file excluded by a root `*.log`.
 */
function isIgnored(scopes: IgnoreScope[], target: string, isDirectory: boolean): boolean {
	const probe = isDirectory ? `${target}/` : target;
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		const result = scope.ig.test(relativeTo(scope.base, probe));
		if (result.ignored) {
			return true;
		}
		if (result.unignored) {
			return false;
		}
	}
	return false;
}

function loadGitignore(dir: string): Ignore | null {
	const gitignorePath = path.join(dir, '.gitignore');
	if (!fs.existsSync(gitignorePath)) {
		return null;
	}
	return ignore().add(fs.readFileSync(gitignorePath, 'utf8'));
}

/**
 * Walks `sourceDir` and decides which files may be uploaded. Honors the root
 * and every nested .gitignore (each relative to its own directory), the
 * built-in directory ignores, and the sensitive-file deny list.
 */
export async function collectFiles(sourceDir: string): Promise<CollectResult> {
	const files: string[] = [];
	const sensitive: string[] = [];
	const sensitiveMatcher = ignore().add(SENSITIVE_PATTERNS);

	const rootIg = ignore().add(DEFAULT_IGNORES);
	const rootGitignore = loadGitignore(sourceDir);
	if (rootGitignore) {
		rootIg.add(rootGitignore);
	}

	async function walk(dir: string, base: string, scopes: IgnoreScope[]): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = base === '' ? entry.name : `${base}/${entry.name}`;
			const isDirectory = entry.isDirectory();

			if (isIgnored(scopes, relativePath, isDirectory)) {
				continue;
			}

			if (isDirectory) {
				const nested = loadGitignore(fullPath);
				const childScopes = nested ? [...scopes, { base: relativePath, ig: nested }] : scopes;
				await walk(fullPath, relativePath, childScopes);
				continue;
			}

			if (sensitiveMatcher.ignores(relativePath)) {
				sensitive.push(relativePath);
				continue;
			}

			files.push(relativePath);
		}
	}

	await walk(sourceDir, '', [{ base: '', ig: rootIg }]);
	return { files, sensitive };
}

/** Writes a zip at `outPath` containing exactly `files` (workspace-relative POSIX paths). */
export function createZip(sourceDir: string, files: string[], outPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => resolve());
		output.on('error', reject);
		archive.on('error', reject);
		archive.pipe(output);

		for (const file of files) {
			archive.file(path.join(sourceDir, ...file.split('/')), { name: toPosix(file) });
		}

		archive.finalize().catch(reject);
	});
}
