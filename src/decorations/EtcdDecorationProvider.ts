import * as vscode from 'vscode';

export class EtcdDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly getColorFor: (uri: vscode.Uri) => vscode.ThemeColor | undefined) {}

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const color = this.getColorFor(uri);
    if (color) {
      return { color };
    }
    return undefined;
  }

  refresh(uris?: vscode.Uri | vscode.Uri[]) {
    this.emitter.fire(uris);
  }
}


