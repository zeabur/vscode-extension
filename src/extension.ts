import path from 'path';
import * as vscode from 'vscode';
import fs from 'fs';
import archiver from 'archiver';

export function activate(context: vscode.ExtensionContext) {

	// deploy
	const disposable = vscode.commands.registerCommand('zeabur-vscode.deploy', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		const workspacePath = workspaceFolders[0].uri.fsPath;
		const outputPath = path.join(workspacePath, 'project.zip');

		try {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Deploying project ...',
				cancellable: false
			}, async () => {
				await compressDirectory(workspacePath, outputPath);
				const zipContent = await fs.promises.readFile(outputPath);
				const projectName = path.basename(workspacePath);
				const result = await deployToZeabur(zipContent, projectName, workspacePath);
				vscode.env.openExternal(vscode.Uri.parse(`https://dash.zeabur.com/projects/${result.projectID}`));
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(`Error: ${err.message}`);
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
	const openWebsite = vscode.commands.registerCommand('zeabur-vscode.openWebsite', async () => {
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

		try {
			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			const domain = await getDomainOfService(config.projectID, config.serviceID);
			vscode.env.openExternal(vscode.Uri.parse(`https://${domain}`));
		} catch (err: any) {
			vscode.window.showErrorMessage(`Error: ${err.message}`);
		}
	});
	context.subscriptions.push(openWebsite);

	vscode.window.registerTreeDataProvider('zeabur-deploy', new ZeaburDeployProvider());
}

function compressDirectory(sourceDir: string, outPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => resolve());
		archive.on('error', err => reject(err));

		archive.pipe(output);
		archive.glob('**/*', { cwd: sourceDir, ignore: ['**/node_modules/**'] });
		archive.finalize();
	});
}

async function deployToZeabur(zipContent: Buffer, projectName: string, workspacePath: string) {
	const convertedName = convertTitle(projectName);
	const blob = new Blob([zipContent], { type: 'application/zip' });
	return await deploy(blob, convertedName, workspacePath);
}

const API_URL = "https://gateway.zeabur.com/graphql";

async function getOrCreateProjectAndService(workspacePath: string, serviceName: string): Promise<{ projectID: string, serviceID: string }> {
	const configPath = path.join(workspacePath, '.zeabur', 'config.json');

	if (fs.existsSync(configPath)) {
		const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		if (config.projectID && config.serviceID) {
			return { projectID: config.projectID, serviceID: config.serviceID };
		}
	}

	const projectID = await createTemporaryProject();
	const serviceID = await createService(projectID, serviceName);

	// Ensure .zeabur directory exists
	const zeaburDir = path.join(workspacePath, '.zeabur');
	if (!fs.existsSync(zeaburDir)) {
		fs.mkdirSync(zeaburDir, { recursive: true });
	}

	// Write config
	fs.writeFileSync(configPath, JSON.stringify({ projectID, serviceID }, null, 2));

	return { projectID, serviceID };
}

async function createTemporaryProject(): Promise<string> {
	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `mutation CreateTemporaryProject() {
                createTemporaryProject() {
                    _id
                }
            }`,
			}),
		});

		const response = await res.json();
		const { data } = response as { data: { createTemporaryProject: { _id: string } } };

		return data.createTemporaryProject._id;
	} catch (error) {
		console.error('Error creating temporary project:', error);
		throw error;
	}
}

async function createService(
	projectID: string,
	serviceName: string
): Promise<string> {
	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `mutation CreateService($projectID: ObjectID!, $template: ServiceTemplate!, $name: String!) {
                createService(projectID: $projectID, template: $template, name: $name) {
                    _id
                }
            }`,
				variables: {
					projectID,
					template: "GIT",
					name: serviceName,
				},
			}),
		});

		const response = await res.json();
		const { data } = response as { data: { createService: { _id: string } } };

		return data.createService._id;
	} catch (error) {
		console.error('Error creating service:', error);
		throw error;
	}
}

async function getEnvironment(projectID: string): Promise<string> {
	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `query GetEnvironment($projectID: ObjectID!) {
                environments(projectID: $projectID) {
                    _id
                }
            }`,
				variables: {
					projectID,
				},
			}),
		});

		const response = await res.json();
		const { data } = response as { data: { environments: Array<{ _id: string }> } };

		if (!data.environments || data.environments.length === 0) {
			throw new Error('No environments found for the project');
		}
		return data.environments[0]._id;
	} catch (error) {
		console.error('Error getting environment:', error);
		throw error;
	}
}

async function createDomain(serviceID: string, environmentID: string, serviceName: string, domainName?: string): Promise<string> {
	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `mutation CreateDomain($serviceID: ObjectID!, $environmentID: ObjectID!, $domain: String!, $isGenerated: Boolean!) {
                addDomain(serviceID: $serviceID, environmentID: $environmentID, domain: $domain, isGenerated: $isGenerated) {
                    domain
                }
            }`,
				variables: {
					serviceID,
					environmentID,
					domain: domainName ?? `${serviceName + generateRandomString()}`,
					isGenerated: true,
				},
			}),
		});

		const response = await res.json();
		const { data } = response as { data: { addDomain: { domain: string } } };
		return data.addDomain.domain;
	} catch (error) {
		console.error('Error creating domain:', error);
		throw error;
	}
}

async function getDomainOfService(projectID: string, serviceID: string): Promise<string> {
	try {
		const getEnvironmentsRes = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `query GetEnvironments($projectID: ObjectID!) {
				environments(projectID: $projectID) {
					_id
				}
			}`,
				variables: { projectID },
			}),
		});

		const getEnvironmentsResponse = (await getEnvironmentsRes.json()) as { data: { environments: Array<{ _id: string }> } };

		if (!getEnvironmentsResponse.data.environments || getEnvironmentsResponse.data.environments.length === 0) {
			throw new Error('No environments found for the project');
		}

		const environmentID = getEnvironmentsResponse.data.environments[0]._id;

		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: `query GetDomain($serviceID: ObjectID!, $environmentID: ObjectID!) {
				service(_id: $serviceID) {
					domains(environmentID: $environmentID) {
					  domain
					}
				}
			}`,
				variables: {
					serviceID,
					environmentID,
				},
			}),
		});

		const response = (await res.json()) as { data: { service: { domains: Array<{ domain: string }> } } };
		const data = response.data;

		if (!data.service.domains || data.service.domains.length === 0) {
			throw new Error('No domain found for the service');
		}

		return data.service.domains[0].domain;
	} catch (error) {
		console.error('Error getting domain:', error);
		throw error;
	}
}

async function deploy(code: Blob, serviceName: string, workspacePath: string) {
	try {
		if (!code) {
			throw new Error("Code is required");
		}

		const { projectID, serviceID } = await getOrCreateProjectAndService(workspacePath, serviceName);
		const environmentID = await getEnvironment(projectID);

		const formData = new FormData();
		formData.append("environment", environmentID);
		formData.append("code", code, "code.zip");

		await fetch(
			`https://gateway.zeabur.com/projects/${projectID}/services/${serviceID}/deploy`,
			{
				method: "POST",
				body: formData,
			}
		);

		try {
			const domain = await getDomainOfService(projectID, serviceID);
			return { projectID, domain, };
		} catch (error) {
			const domain = await createDomain(serviceID, environmentID, serviceName);
			return { projectID, domain, };
		}
	} catch (error) {
		console.error(error);
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
		vscode.window.showErrorMessage('No project deployed yet');
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
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Thenable<vscode.TreeItem[]> {
		return Promise.resolve([]);
	}
}