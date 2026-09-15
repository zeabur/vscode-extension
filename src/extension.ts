import path from 'path';
import os from 'os';
import * as vscode from 'vscode';
import fs from 'fs';
import crypto from 'crypto';
import { collectFiles, createZip } from './packager';

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
	const disposable = vscode.commands.registerCommand('zeabur-vscode.deploy', async (source?: DeploySource) => {
		console.log('[zeabur-vscode] Deploy command triggered', source ?? 'ui');

		if (isDeploying) {
			vscode.window.showInformationMessage('A Zeabur deployment is already in progress.');
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		const workspacePath = workspaceFolders[0].uri.fsPath;
		const workspaceName = workspaceFolders[0].name;

		// Hold the lock for the whole flow, including scanning and the
		// confirmation prompt, so a second trigger cannot replace an open
		// confirmation. Every exit path below releases it in `finally`.
		isDeploying = true;
		zeaburDeployProvider.refresh();

		let tmpDir: string | undefined;
		try {
			const { files, sensitive } = await collectFiles(workspacePath);
			logFileList(workspaceName, files, sensitive);

			if (files.length === 0) {
				vscode.window.showErrorMessage('No files to deploy: every file in the workspace is ignored or excluded.');
				return;
			}

			const selected = await confirmFiles(workspaceName, files, sensitive, source);
			if (!selected) {
				channel.appendLine('[zeabur-vscode] Deployment cancelled by user');
				return;
			}

			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zeabur-deploy-'));
			const outputPath = path.join(tmpDir, 'project.zip');

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Deploying project ...',
				cancellable: false
			}, async () => {
				await createZip(workspacePath, selected, outputPath);
				const zipContent = await fs.promises.readFile(outputPath);
				const blob = new Blob([zipContent], { type: 'application/zip' });

				const redirectUrl = await deploy(blob, workspacePath);
				vscode.env.openExternal(vscode.Uri.parse(redirectUrl));
			});
		} catch (err: any) {
			channel.appendLine(`${err}`);
			vscode.window.showErrorMessage(`${err}`);
		} finally {
			// Clean up the temporary zip file
			if (tmpDir) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
			isDeploying = false;
			zeaburDeployProvider.refresh();
		}
	});

	const uriHandler = vscode.window.registerUriHandler({
		handleUri: (uri: vscode.Uri) => {
			console.log('[zeabur-vscode] URI received:', uri.toString());
			if (uri.path === '/deploy') {
				vscode.commands.executeCommand('zeabur-vscode.deploy', 'uri');
			}
		}
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(uriHandler);

	const zeaburDeployProvider = new ZeaburDeployProvider(context);
	vscode.window.registerTreeDataProvider('zeabur-deploy', zeaburDeployProvider);
}

type DeploySource = 'uri';

function logFileList(workspaceName: string, files: string[], sensitive: string[]): void {
	channel.appendLine(`[zeabur-vscode] Files to deploy from "${workspaceName}" (${files.length}):`);
	for (const file of files) {
		channel.appendLine(`  + ${file}`);
	}
	if (sensitive.length > 0) {
		channel.appendLine(`[zeabur-vscode] Sensitive files excluded (${sensitive.length}):`);
		for (const file of sensitive) {
			channel.appendLine(`  - ${file}`);
		}
	}
}

/**
 * Shows the upload file list and asks the user to confirm. Every file is
 * pre-selected; the user can deselect files before uploading. Returns the
 * files to upload, or undefined when the user cancels.
 */
async function confirmFiles(
	workspaceName: string,
	files: string[],
	sensitive: string[],
	source?: DeploySource,
): Promise<string[] | undefined> {
	channel.show(true);

	const title = source === 'uri'
		? `An external link requested to deploy "${workspaceName}" to Zeabur`
		: `Deploy "${workspaceName}" to Zeabur`;

	const excludedNote = sensitive.length > 0
		? ` · ${sensitive.length} sensitive file(s) excluded (see "zeabur" output)`
		: '';

	const items: vscode.QuickPickItem[] = files.map(file => ({ label: file, picked: true }));
	const picked = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		ignoreFocusOut: true,
		title,
		placeHolder: `${files.length} file(s) will be uploaded${excludedNote}. Press Enter to deploy, Esc to cancel.`,
	});

	if (!picked || picked.length === 0) {
		return undefined;
	}
	return picked.map(item => item.label);
}

async function calculateSHA256(blob: Blob): Promise<string> {
	const arrayBuffer = await blob.arrayBuffer();
	const hash = crypto.createHash('sha256');
	hash.update(Buffer.from(arrayBuffer));
	return hash.digest('base64');
}

async function deploy(code: Blob, workspacePath: string) {
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

		if (editor || workspacePath) {
			requestBody.metadata = {};
			
			if (editor) {
				requestBody.metadata.uploaded_from = editor;
				channel.appendLine(`[zeabur-vscode] Uploaded from ${editor}`);
			}
			
			if (workspacePath) {
				requestBody.metadata.workspace_path = workspacePath;
				channel.appendLine(`[zeabur-vscode] Workspace path: ${workspacePath}`);
			}
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
