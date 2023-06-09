import vscode from "vscode";
import { l10n } from "vscode";
import { SopsFsProvider } from "./sopsfs-provider";
import which from "which";
import path from "path";

async function mount(uri: vscode.Uri) {
  const sopsUri = SopsFsProvider.composeUri(uri);
  const basename = path.basename(uri.path);
  try {
    await vscode.workspace.fs.stat(sopsUri);
  } catch (e) {
    vscode.window.showErrorMessage(
      l10n.t("Mounting failed, {0} might not be a valid SOPS file", basename)
    );
    console.error("failed to read sops file: " + e);
    return;
  }
  if (vscode.workspace.getWorkspaceFolder(sopsUri) === undefined) {
    vscode.workspace.updateWorkspaceFolders(0, 0, {
      name: "sops:" + basename,
      uri: sopsUri,
    });
  } else {
    vscode.window.showWarningMessage(
      l10n.t("Already mounted SOPS file {0}", basename)
    );
  }
}

async function unmount(uri: vscode.Uri) {
  const sopsUri = SopsFsProvider.composeUri(uri);
  const basename = path.basename(uri.path);
  const folder = vscode.workspace.getWorkspaceFolder(sopsUri);
  if (folder) {
    vscode.workspace.updateWorkspaceFolders(folder.index, 1);
  } else {
    vscode.window.showWarningMessage(
      l10n.t("SOPS file {0} not mounted", basename)
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration();
  const sopsCmd =
    (config.get("sopsfs.sopsCommand") as string | undefined) || "sops";
  const env = config.get("sopsfs.env") as object | undefined;

  try {
    which.sync(sopsCmd);
  } catch (e) {
    vscode.window.showErrorMessage(
      l10n.t(
        "Can't not found sops command(\"{0}\"), make sure it's installed.",
        sopsCmd
      )
    );
  }

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      "sops",
      new SopsFsProvider({
        sopsCmd,
        env: {
          ...env,
        },
      }),
      {
        isCaseSensitive: true,
        isReadonly: false,
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sopsfs.mountSopsFile", (uri) => mount(uri))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sopsfs.unmountSopsFile", (uri) =>
      unmount(uri)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "sopsfs.mountSopsEditor",
      (editor) => mount(editor.document.uri)
    )
  );
}

export function deactivate() {}
