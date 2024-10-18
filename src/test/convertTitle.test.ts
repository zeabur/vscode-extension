import * as assert from 'assert';
import * as vscode from 'vscode';
import * as extension from '../extension';

suite('Extension Test Suite', () => {
  suiteTeardown(() => {
    vscode.window.showInformationMessage('All tests done!');
  });

  test('convertTitle', () => {
    const validDomainNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$/;

    assert.ok(extension.convertTitle("aaaa").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("中文測試").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("中文測試-abcd").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("12345abcd").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("-12345abcd").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("-中文測試-12345abcd-").match(validDomainNameRegex));
    assert.ok(extension.convertTitle("").match(validDomainNameRegex));
  });
});
