# Zeabur for Visual Studio Code

This project is an extension for Visual Studio Code that allows you to deploy your current workspace to Zeabur with a single click.

The extension is released. You can download it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Zeabur.zeabur-vscode).

## What gets uploaded

Before uploading, the extension lists every file it is about to send in the `zeabur` output channel and asks you to confirm. You can deselect files in that list before deploying.

The following are never uploaded:

- Anything matched by the workspace's `.gitignore`, including nested `.gitignore` files.
- `node_modules/`, `.git/`, `.zeabur/`, `venv/`, `env/` and any hidden directory.
- Common secret files at any depth: `.env` and `.env.*` (except `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.npmrc`, `.yarnrc`, `.pypirc`, `.netrc`, `.htpasswd`.

Deployments triggered from an external `vscode://zeabur.zeabur-vscode/deploy` link go through the same confirmation step.
