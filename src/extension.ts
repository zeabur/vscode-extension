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
					const projectName = path.basename(workspacePath);
					const result = await deployToZeabur(zipContent, projectName, workspacePath, context);
					vscode.window.showInformationMessage(`Project uploaded successfully, you can now open the dashboard to see the deployment status`);
					vscode.env.openExternal(vscode.Uri.parse(`https://dash.zeabur.com/projects/${result.projectID}`));
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

	// open dashboard
	const openDashboard = vscode.commands.registerCommand('zeabur-vscode.openDashboard', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		const workspacePath = workspaceFolders[0].uri.fsPath;
		const configPath = path.join(workspacePath, '.zeabur', 'config.json');

		if (!fs.existsSync(configPath)) {
			vscode.window.showErrorMessage('No project deployed yet');
			return;
		}

		const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		vscode.env.openExternal(vscode.Uri.parse(`https://dash.zeabur.com/projects/${config.projectID}`));
	});
	context.subscriptions.push(openDashboard);

	// open deployed website
	const openWebsite = vscode.commands.registerCommand('zeabur-vscode.openWebsite', async (domain: string) => {
		try {
			vscode.env.openExternal(vscode.Uri.parse(`https://${domain}`));
		} catch (err: any) {
			vscode.window.showErrorMessage(`Error: ${err.message}`);
		}
	});
	context.subscriptions.push(openWebsite);

	const zeaburDeployProvider = new ZeaburDeployProvider(context);

	// Watch for changes in the .zeabur/config.json file
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspacePath = workspaceFolders[0].uri.fsPath;
		const zeaburDirPath = path.join(workspacePath, '.zeabur');
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(zeaburDirPath, '**'));

		watcher.onDidChange(() => zeaburDeployProvider.refresh());
		watcher.onDidCreate(() => zeaburDeployProvider.refresh());
		watcher.onDidDelete(() => zeaburDeployProvider.refresh());

		context.subscriptions.push(watcher);
	}

	const setApiKeyCommand = vscode.commands.registerCommand('zeabur-vscode.setApiKey', async () => {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your Zeabur API Key',
			ignoreFocusOut: true,
			password: true,
		});

		if (apiKey) {
			context.globalState.update('zeaburApiKey', apiKey);
			vscode.window.showInformationMessage('API Key saved successfully');
			zeaburDeployProvider.refresh();
		} else {
			vscode.window.showErrorMessage('API Key is required');
		}
	});
	context.subscriptions.push(setApiKeyCommand);

	const logoutCommand = vscode.commands.registerCommand('zeabur-vscode.logout', async () => {
		context.globalState.update('zeaburApiKey', undefined);
		vscode.window.showInformationMessage('API Key removed successfully');
		zeaburDeployProvider.refresh();
	});
	context.subscriptions.push(logoutCommand);

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

async function deployToZeabur(zipContent: Buffer, projectName: string, workspacePath: string, context: vscode.ExtensionContext) {
	const convertedName = convertTitle(projectName);
	const blob = new Blob([zipContent], { type: 'application/zip' });
	return await deploy(blob, convertedName, workspacePath, context);
}

const API_URL = "https://gateway.zeabur.com/graphql";

const getToken = (context: vscode.ExtensionContext) => {
	return context.globalState.get<string>('zeaburApiKey');
};

async function graphqlRequest(query: string, variables: any = {}, context: vscode.ExtensionContext): Promise<any> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	const token = getToken(context);
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}

	try {
		channel.appendLine(`GraphQL request: ${query} ${JSON.stringify(variables)}`);
		const res = await fetch(API_URL, {
			method: "POST",
			headers: headers,
			body: JSON.stringify({ query, variables }),
		});
		const data = await res.json() as any;
		channel.appendLine(`GraphQL response: ${JSON.stringify(data)}`);

		if (data.errors && data.errors.length > 0 && data.errors[0].message === 'Permission denied') {
			vscode.window.showErrorMessage('This project is claimed, please sign in to your Zeabur account.');
		}

		return data;
	} catch (error) {
		console.error('GraphQL request error:', error);
		throw error;
	}
}

async function getOrCreateProjectAndService(workspacePath: string, serviceName: string, context: vscode.ExtensionContext) {
	const configPath = path.join(workspacePath, '.zeabur', 'config.json');

	if (fs.existsSync(configPath)) {
		const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		if (config.projectID && config.serviceID) {
			return { projectID: config.projectID, serviceID: config.serviceID, justCreated: false };
		}
	}

	const projectID = await createTemporaryProject(context);
	const serviceID = await createService(projectID, serviceName, context);

	// Ensure .zeabur directory exists
	const zeaburDir = path.join(workspacePath, '.zeabur');
	if (!fs.existsSync(zeaburDir)) {
		fs.mkdirSync(zeaburDir, { recursive: true });
	}

	// Write config
	fs.writeFileSync(configPath, JSON.stringify({ projectID, serviceID }, null, 2));

	return { projectID, serviceID, justCreated: true };
}

async function createTemporaryProject(context: vscode.ExtensionContext): Promise<string> {
	const query = `mutation CreateTemporaryProject {
		createTemporaryProject {
			_id
		}
	}`;

	const response = await graphqlRequest(query, {}, context);
	const { data } = response as { data?: { createTemporaryProject: { _id: string } } };
	if (!data) {
		throw new Error(response.errors[0].message);
	}

	return data.createTemporaryProject._id;
}

async function createService(projectID: string, serviceName: string, context: vscode.ExtensionContext): Promise<string> {
	const query = `mutation CreateService($projectID: ObjectID!, $template: ServiceTemplate!, $name: String!) {
		createService(projectID: $projectID, template: $template, name: $name) {
			_id
		}
	}`;
	const variables = { projectID, template: "GIT", name: serviceName };
	const response = await graphqlRequest(query, variables, context);
	const { data } = response as { data?: { createService: { _id: string } } };
	if (!data) {
		throw new Error(response.errors[0].message);
	}

	return data.createService._id;
}

async function getEnvironment(projectID: string, context: vscode.ExtensionContext): Promise<string> {
	const query = `query GetEnvironment($projectID: ObjectID!) {
		environments(projectID: $projectID) {
			_id
		}
	}`;
	const variables = { projectID };
	const response = await graphqlRequest(query, variables, context);
	const { data } = response as { data?: { environments: Array<{ _id: string }> } };
	if (!data) {
		throw new Error(response.errors[0].message);
	}

	if (!data.environments || data.environments.length === 0) {
		throw new Error('No environments found for the project');
	}
	return data.environments[0]._id;
}

async function createDomain(context: vscode.ExtensionContext, serviceID: string, environmentID: string, serviceName: string, domainName?: string): Promise<string> {
	const query = `mutation CreateDomain($serviceID: ObjectID!, $environmentID: ObjectID!, $domain: String!, $isGenerated: Boolean!) {
		addDomain(serviceID: $serviceID, environmentID: $environmentID, domain: $domain, isGenerated: $isGenerated) {
			domain
		}
	}`;
	const variables = {
		serviceID,
		environmentID,
		domain: domainName ?? `${serviceName + generateRandomString()}`,
		isGenerated: true,
	};
	const response = await graphqlRequest(query, variables, context);
	const { data } = response as { data?: { addDomain: { domain: string } } };
	if (!data) {
		throw new Error(response.errors[0].message);
	}

	return data.addDomain.domain;
}

async function getDomainOfService(projectID: string, serviceID: string, context: vscode.ExtensionContext): Promise<string> {
	const getEnvironmentsQuery = `query GetEnvironments($projectID: ObjectID!) {
		environments(projectID: $projectID) {
			_id
		}
	}`;
	const getEnvironmentsVariables = { projectID };
	const getEnvironmentsResponse = await graphqlRequest(getEnvironmentsQuery, getEnvironmentsVariables, context);
	const { data: environmentsData } = getEnvironmentsResponse as { data?: { environments: Array<{ _id: string }> } };

	if (!getEnvironmentsResponse.data.environments || getEnvironmentsResponse.data.environments.length === 0) {
		throw new Error('No environments found for the project');
	}

	const environmentID = getEnvironmentsResponse.data.environments[0]._id;

	const getDomainQuery = `query GetDomain($serviceID: ObjectID!, $environmentID: ObjectID!) {
		service(_id: $serviceID) {
			domains(environmentID: $environmentID) {
				domain
			}
		}
	}`;
	const getDomainVariables = { serviceID, environmentID };
	const getDomainResponse = await graphqlRequest(getDomainQuery, getDomainVariables, context);
	const { data: domainData } = getDomainResponse as { data?: { service: { domains: Array<{ domain: string }> } } };
	if (!domainData) {
		throw new Error(getDomainResponse.errors[0].message);
	}

	if (!domainData.service.domains || domainData.service.domains.length === 0) {
		throw new Error('No domain found for the service');
	}

	return domainData.service.domains[0].domain;
}

async function deploy(code: Blob, serviceName: string, workspacePath: string, context: vscode.ExtensionContext) {
	try {
		if (!code) {
			throw new Error("Code is required");
		}

		const { projectID, serviceID, justCreated } = await getOrCreateProjectAndService(workspacePath, serviceName, context);

		// environment is async created, so we need to wait a bit for it to be ready if the project is just created
		if (justCreated) {
			await new Promise(resolve => setTimeout(resolve, 3000));
		}

		const environmentID = await getEnvironment(projectID, context);

		const formData = new FormData();
		formData.append("environment", environmentID);
		formData.append("code", code, "code.zip");

		const token = getToken(context);
		const headers: Record<string, string> = {};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		await fetch(
			`https://gateway.zeabur.com/projects/${projectID}/services/${serviceID}/deploy`,
			{
				method: "POST",
				headers: headers,
				body: formData,
			}
		);

		try {
			const domain = await getDomainOfService(projectID, serviceID, context);
			return { projectID, domain, };
		} catch (error) {
			const domain = await createDomain(context, serviceID, environmentID, serviceName);
			return { projectID, domain, };
		}
	} catch (error) {
		channel.appendLine(`${error}`);
		vscode.window.showErrorMessage(`${error}`);
		throw error;
	}
}

function convertTitle(title: string) {
	return title.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

function generateRandomString() {
	let result = "";
	const characters = "abcdefghijklmnopqrstuvwxyz";
	const charactersLength = characters.length;
	for (let i = 0; i < 6; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}

function getConfig() {
	const workspaceFolders = vscode.workspace.workspaceFolders;

	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('No workspace folder open');
		return;
	}

	const workspacePath = workspaceFolders[0].uri.fsPath;
	const configPath = path.join(workspacePath, '.zeabur', 'config.json');

	if (!fs.existsSync(configPath)) {
		return;
	}

	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectID: string, serviceID: string };
	} catch (err: any) {
		vscode.window.showErrorMessage(`Error: ${err.message}`);
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
		if (!element) {
			return this.getRootItems();
		}

		switch (element.label) {
			case 'User':
				return this.getLoginInformationItems();
			case 'Project':
				return this.getProjectInformationItems();
			case 'Actions':
				return this.getActionItems();
			default:
				return [];
		}
	}

	private async getRootItems(): Promise<vscode.TreeItem[]> {
		const items = [
			new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded),
			new vscode.TreeItem('User', vscode.TreeItemCollapsibleState.Expanded),
		];

		const config = getConfig();
		if (config && config.projectID && config.serviceID) {
			items.push(new vscode.TreeItem('Project', vscode.TreeItemCollapsibleState.Expanded));
		}

		return items;
	}

	private async getLoginInformationItems(): Promise<vscode.TreeItem[]> {
		const items: vscode.TreeItem[] = [];
		const apiKey = this.context.globalState.get<string>('zeaburApiKey');

		if (apiKey) {
			try {
				const query = `query {
					me {
						_id
						username
						email
					}
				}`;
				const response = await graphqlRequest(query, {}, this.context);
				const { data } = response as { data?: { me: { _id: string, username: string, email: string } } };
				if (!data) {
					throw new Error(response.errors[0].message);
				}

				items.push(new vscode.TreeItem(`Username: ${data.me.username}`, vscode.TreeItemCollapsibleState.None));
				items.push(new vscode.TreeItem(`Email: ${data.me.email}`, vscode.TreeItemCollapsibleState.None));
			} catch (error) {
				this.context.globalState.update('zeaburApiKey', undefined);
				this.refresh();
			}
			items.push(getActionTreeItem('Logout', 'logout'));
		} else {
			items.push(getActionTreeItem('Login to Zeabur', 'setApiKey'));
		}

		return items;
	}

	private async getProjectInformationItems(): Promise<vscode.TreeItem[]> {
		const items: vscode.TreeItem[] = [];
		const config = getConfig();

		if (config && config.projectID && config.serviceID) {
			items.push(new vscode.TreeItem(`Project: ${config.projectID}`, vscode.TreeItemCollapsibleState.None));
			items.push(new vscode.TreeItem(`Service: ${config.serviceID}`, vscode.TreeItemCollapsibleState.None));
		} else {
			items.push(new vscode.TreeItem('No project deployed yet', vscode.TreeItemCollapsibleState.None));
		}

		return items;
	}

	private async getActionItems(): Promise<vscode.TreeItem[]> {
		const items: vscode.TreeItem[] = [];
		items.push(getActionTreeItem('Deploy', 'deploy'));

		const config = getConfig();
		if (config && config.projectID && config.serviceID) {
			items.push(getActionTreeItem('Open Zeabur Dashboard', 'openDashboard'));

			try {
				const domain = await getDomainOfService(config.projectID, config.serviceID, this.context);
				if (domain) {
					items.push(getActionTreeItem('Open Deployed Website', 'openWebsite', [domain]));
				}
			} catch (error) {
				channel.appendLine(`Error fetching domain: ${error}`);
			}
		}

		return items;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
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
