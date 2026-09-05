import * as vscode from 'vscode';
import { IgDmPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
  const provider = new IgDmPanel(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('igdm.chatView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('igdm.openPanel', () => {
      vscode.commands.executeCommand('igdm.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('igdm.hidePanel', () => {
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    })
  );
}

export function deactivate() {}
