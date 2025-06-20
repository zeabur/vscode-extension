import path from 'path';
import * as vscode from 'vscode';
import fs from 'fs';
import archiver from 'archiver';
import crypto from 'crypto';
import ignore from 'ignore';
import { readdir } from 'fs/promises';

const channel = vscode.window.createOutputChannel('zeabur');

interface CreateUploadSessionResponse {
	presign_url: string;
	presign_header: Record<string, string>;
	upload_id: string;
}

interface PrepareUploadResponse {
	url: string;
}

interface ErrorResponse {
	error: string;
}

let isDeploying = false;

function detectEditor(): string | null {
	const execPath = process.execPath.toLowerCase();

	if (execPath.includes('visual studio code')) {
		return 'Visual Studio Code';
	} else if (execPath.includes('vscode')) {
		return 'Visual Studio Code';
	} else if (execPath.includes('codium')) {
		return 'VSCodium';
	} else if (execPath.includes('cursor')) {
		return 'Cursor';
	} else if (execPath.includes('windsurf')) {
		return 'Windsurf';
	} else if (execPath.includes('trae')) {
		return 'Trae';
	} else if (execPath.includes('sublime')) {
		return 'Sublime Text';
	} else if (execPath.includes('atom')) {
		return 'Atom';
	} else if (execPath.includes('brackets')) {
		return 'Brackets';
	} else if (execPath.includes('theia')) {
		return 'Theia';
	} else if (execPath.includes('code')) {
		return 'Visual Studio Code';
	}

	return null;
}

export function activate(context: vscode.ExtensionContext) {

	// deploy
	const disposable = vscode.commands.registerCommand('zeabur-vscode.deploy', async () => {
		console.log('[zeabur-vscode] Deploy command triggered');
		isDeploying = true;
		zeaburDeployProvider.refresh();

		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		const workspacePath = workspaceFolders[0].uri.fsPath;
		const outputPath = path.join(workspacePath, '.zeabur/project.zip');

		const outputDir = path.dirname(outputPath);
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Deploying project ...',
				cancellable: false
			}, async () => {
				try {
					await compressDirectory(workspacePath, outputPath);
					const zipContent = await fs.promises.readFile(outputPath);
					const blob = new Blob([zipContent], { type: 'application/zip' });

					const redirectUrl = await deploy(blob);
					vscode.env.openExternal(vscode.Uri.parse(redirectUrl));
				} catch (error) {
					channel.appendLine(`${error}`);
					vscode.window.showErrorMessage(`${error}`);
					throw error;
				}
			});

		} catch (err: any) {
			vscode.window.showErrorMessage(`${err}`);
		} finally {
			// Clean up the temporary zip file
			fs.unlinkSync(outputPath);
			isDeploying = false;
			zeaburDeployProvider.refresh();
		}
	});

	context.subscriptions.push(disposable);

	const zeaburDeployProvider = new ZeaburDeployProvider(context);
	vscode.window.registerTreeDataProvider('zeabur-deploy', zeaburDeployProvider);
}

async function compressDirectory(sourceDir: string, outPath: string): Promise<void> {
	const output = fs.createWriteStream(outPath);
	const archive = archiver('zip', { zlib: { level: 9 } });

	return new Promise(async (resolve, reject) => {
		output.on('close', () => resolve());
		archive.on('error', err => reject(err));
		archive.pipe(output);

		// Load .gitignore patterns
		const gitignorePath = path.join(sourceDir, '.gitignore');
		const ig = ignore().add([
			'node_modules/',
			'.git/',
			'.zeabur/',
			'venv/',
			'env/',
			'.*/',
		]);

		if (fs.existsSync(gitignorePath)) {
			const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
			ig.add(gitignoreContent);
		}

		// Recursively add files manually
		async function addFilesRecursively(dir: string, base = '') {
			const entries = await readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relativePath = path.join(base, entry.name);
				const normalizedPath = relativePath.replace(/\\/g, '/');

				if (ig.ignores(normalizedPath)) {continue;}

				if (entry.isDirectory()) {
					await addFilesRecursively(fullPath, normalizedPath);
				} else {
					console.log('[zeabur-vscode] Adding file:', normalizedPath);
					archive.file(fullPath, { name: normalizedPath });
				}
			}
		}

		await addFilesRecursively(sourceDir);
		await archive.finalize();
	});
}

async function calculateSHA256(blob: Blob): Promise<string> {
	const arrayBuffer = await blob.arrayBuffer();
	const hash = crypto.createHash('sha256');
	hash.update(Buffer.from(arrayBuffer));
	return hash.digest('base64');
}

async function deploy(code: Blob) {
	try {
		if (!code) {
			throw new Error("Code is required");
		}

		// Calculate content hash
		const contentHash = await calculateSHA256(code);
		const contentLength = code.size;

		// Create upload session
		const createSessionRes = await fetch('https://api.zeabur.com/v2/upload', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				content_hash: contentHash,
				content_hash_algorithm: 'sha256',
				content_length: contentLength
			})
		});

		if (!createSessionRes.ok) {
			const errorData = await createSessionRes.json() as ErrorResponse;
			throw new Error(errorData.error || `Failed to create upload session: ${createSessionRes.statusText}`);
		}

		const { presign_url, presign_header, upload_id } = await createSessionRes.json() as CreateUploadSessionResponse;

		// Upload file using presigned URL
		const uploadRes = await fetch(presign_url, {
			method: 'PUT',
			headers: {
				...presign_header,
				'Content-Length': contentLength.toString()
			},
			body: code
		});

		if (!uploadRes.ok) {
			const errorData = await uploadRes.json().catch(() => ({ error: uploadRes.statusText })) as ErrorResponse;
			throw new Error(errorData.error || `Failed to upload file: ${uploadRes.statusText}`);
		}

		// Prepare upload for deployment
		const editor = detectEditor();
		const requestBody: any = {
			upload_type: 'new_project',
		};

		if (editor) {
			requestBody.metadata = {
				uploaded_from: editor,
			};
			channel.appendLine(`[zeabur-vscode] Uploaded from ${editor}`);
		}

		const prepareRes = await fetch(`https://api.zeabur.com/v2/upload/${upload_id}/prepare`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(requestBody)
		});

		if (!prepareRes.ok) {
			const errorData = await prepareRes.json() as ErrorResponse;
			throw new Error(errorData.error || `Failed to prepare upload: ${prepareRes.statusText}`);
		}

		const { url } = await prepareRes.json() as PrepareUploadResponse;
		return url;

	} catch (error) {
		channel.appendLine(`${error}`);
		vscode.window.showErrorMessage(`${error}`);
		throw error;
	}
}

export function deactivate() { }

class ZeaburDeployProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

	constructor(private context: vscode.ExtensionContext) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		return this.getRootItems();
	}

	private async getRootItems(): Promise<vscode.TreeItem[]> {
		const items: vscode.TreeItem[] = [];
		const label = isDeploying ? 'Deploying...' : 'Deploy';
		items.push(getActionTreeItem(label, 'deploy', undefined, isDeploying));
		return items;
	}
}

const getActionTreeItem = (label: string, command: string, args?: string[], disabled = false) => {
	const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	treeItem.contextValue = 'deployAction';
	if (!disabled) {
		treeItem.command = {
			command: 'zeabur-vscode.' + command,
			title: label,
			arguments: args,
		};
	}
	return treeItem;
};
