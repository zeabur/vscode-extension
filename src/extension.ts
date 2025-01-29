import path from 'path';
import * as vscode from 'vscode';
import fs from 'fs';
import archiver from 'archiver';

const channel = vscode.window.createOutputChannel('zeabur');

export function activate(context: vscode.ExtensionContext) {

	// deploy
	const disposable = vscode.commands.registerCommand('zeabur-vscode.deploy', async () => {
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
					const uploadID = await deploy(blob);
					vscode.env.openExternal(vscode.Uri.parse(`https://zeabur.com/uploads/${uploadID}`));
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
		}
	});
	context.subscriptions.push(disposable);

	const zeaburDeployProvider = new ZeaburDeployProvider(context);
	vscode.window.registerTreeDataProvider('zeabur-deploy', zeaburDeployProvider);
}

function compressDirectory(sourceDir: string, outPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => resolve());
		archive.on('error', err => reject(err));

		archive.pipe(output);

		// Read .gitignore file
		const gitignorePath = path.join(sourceDir, '.gitignore');
		let ignorePatterns: string[] = ['**/node_modules/**', '**/.git/**', '**/.zeabur/**', '**/venv/**'];
		if (fs.existsSync(gitignorePath)) {
			const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
			ignorePatterns = ignorePatterns.concat(gitignoreContent.split('\n').filter(line => line.trim() && !line.startsWith('#') && !line.includes('!')));
		}

		// Add files to archive
		archive.glob('**/*', {
			cwd: sourceDir,
			ignore: ignorePatterns,
			dot: true
		});

		archive.finalize();
	});
}

async function deploy(code: Blob) {
	try {
		if (!code) {
			throw new Error("Code is required");
		}

		const formData = new FormData();
		formData.append("code", code, "code.zip");

		const res = await fetch(`https://gateway.zeabur.com/upload`, { method: "POST", body: formData });
		const deployResponse = await res.json() as { id: string };
		
		return deployResponse.id;

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

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		return this.getRootItems();
	}

	private async getRootItems(): Promise<vscode.TreeItem[]> {
		const items: vscode.TreeItem[] = [];
		items.push(getActionTreeItem('Deploy', 'deploy'));
		return items;
	}
}

const getActionTreeItem = (label: string, command: string, args?: string[]) => {
	const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	treeItem.command = {
		command: 'zeabur-vscode.' + command,
		title: label,
		arguments: args,
	};
	return treeItem;
};
