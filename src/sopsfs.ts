import vscode, { Disposable } from "vscode";
import { l10n } from "vscode";
import type { JsonObject, JsonValue } from "type-fest";
import { execa, ExecaError } from "execa";
import { temporaryFileTask } from "tempy";
import fs from "fs/promises";
import objectPath from "object-path";
import path from "path";
import throttle from "lodash.throttle";

const DELETED_MARKER =
  "vscode-sops-fs__deleted__ba2bfdb5-b5c2-460c-a1cd-4e257b05ebee";

enum SopsFormat {
  json = ".json",
  yaml = ".yaml",
  ini = ".ini",
  env = ".env",
  binary = ".sops",
}

interface SopsFsOpenOptions {
  sopsUri: vscode.Uri;
  sopsCmd: string;
  env: Record<string, string>;
}

function uriToObjPath(uri: vscode.Uri) {
  return uri.path.split("/").filter((i) => !!i);
}

function treeValueToType(value: any): vscode.FileType {
  if (typeof value === "object" && value) {
    return vscode.FileType.Directory;
  }
  return vscode.FileType.File;
}

function pathToFormat(p: string): SopsFormat {
  const ext = path.extname(p);
  switch (ext) {
    case ".json":
      return SopsFormat.json;
    case ".yaml":
    case ".yml":
      return SopsFormat.yaml;
    case ".ini":
      return SopsFormat.ini;
    case ".env":
      return SopsFormat.env;
  }
  return SopsFormat.binary;
}

function pathToSopsSetPath(path: string[], object: object): string {
  const res = [];
  for (let i = 0; i < path.length; ++i) {
    const key = path[i];
    const parent = objectPath.get(object, path.slice(0, i));
    if (Array.isArray(parent)) {
      const idx = Number.parseInt(key);
      if (!(idx >= 0 && idx.toString() === key)) {
        throw new Error(l10n.t(`"{0}" is not a valid array index`, key));
      }
      res.push(`[${idx}]`);
    } else {
      res.push(`["${key}"]`);
    }
  }
  return res.join("");
}

function deleteMarker(format: SopsFormat, content: string): string {
  if (format === SopsFormat.binary) {
    throw new Error(`deleteMarker: unhandled format ${format}`);
  }
  if (format === SopsFormat.json) {
    const regex = new RegExp(
      `(,)?([\\n\\s]*"[^"]+"[\\n\\s]*:)?[\\n\\s]*"${DELETED_MARKER}"[\\n\\s]*(,)?`,
      "g"
    );
    return content.replace(regex, (_match, c1, _key, c2) => {
      if (c1 && c2) {
        return ",";
      }
      return "";
    });
  }
  const regex = new RegExp(`.*${DELETED_MARKER}.*\\n?`, "g");
  return content.replace(regex, "");
}

interface TreeNodeFile {
  type: vscode.FileType.File;
  stat: vscode.FileStat;
  value: Uint8Array;
}

interface TreeNodeDir {
  type: vscode.FileType.Directory;
  stat: vscode.FileStat;
  entries: [string, vscode.FileType][];
}

type TreeNode = TreeNodeFile | TreeNodeDir;

/**
 * FS for a specific SOPS file
 */
export class SopsFs implements vscode.FileSystemProvider, vscode.Disposable {
  private onDidChangeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  onDidChangeFile = this.onDidChangeEmitter.event;

  private sopsCmd: string;
  private sopsUri: vscode.Uri;
  private env: Record<string, string>;
  private sopsFormat: SopsFormat;
  private dataFilename: string;

  // watcher for sopsUri
  private watcher: vscode.FileSystemWatcher | null = null;
  private subscriptions: Disposable[] = [];
  private fileChanges: vscode.FileChangeEvent[] = [];
  // TODO: lock tree
  private cachedTree: [vscode.FileStat, Buffer, JsonObject | null] | null =
    null;

  constructor(opts: SopsFsOpenOptions) {
    this.sopsCmd = opts.sopsCmd;
    this.sopsUri = opts.sopsUri;
    this.env = opts.env;
    this.sopsFormat = pathToFormat(this.sopsUri.path);
    this.dataFilename =
      "__sopsfs__" + path.extname(path.basename(this.sopsUri.path, ".sops"));
  }

  dispose() {
    this.subscriptions.forEach((i) => i.dispose());
    this.watcher?.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private isDataFile(path: string[]): boolean {
    return (
      path.length === 1 && !!this.dataFilename && this.dataFilename === path[0]
    );
  }

  private async execSops(
    args: readonly string[],
    toString: true,
    extraEnv?: Record<string, string>
  ): Promise<string>;
  private async execSops(
    args: readonly string[],
    toString: false,
    extraEnv?: Record<string, string>
  ): Promise<Buffer>;
  private async execSops(
    args: readonly string[],
    toString: boolean,
    extraEnv?: Record<string, string>
  ): Promise<string | Buffer> {
    const { stdout } = await execa(this.sopsCmd, args, {
      stripFinalNewline: false,
      env: {
        ...this.env,
        ...extraEnv,
      },
      encoding: toString ? undefined : null,
    });
    return stdout;
  }

  private async getTree(): Promise<
    [vscode.FileStat, Buffer, JsonObject | null]
  > {
    if (this.cachedTree) {
      return this.cachedTree;
    }
    const [stat, content] = await Promise.all([
      vscode.workspace.fs.stat(this.sopsUri),
      vscode.workspace.fs.readFile(this.sopsUri),
    ]);

    const [rawOut, jsonOut] = await temporaryFileTask(
      async (tempFile) => {
        await fs.writeFile(tempFile, content);
        const rawOut = await this.sopsCmdRead(tempFile);
        try {
          let jsonOut = null;
          if (this.sopsFormat !== SopsFormat.binary) {
            const stdout = await this.execSops(
              ["--output-type", "json", "--decrypt", tempFile],
              true
            );
            jsonOut = JSON.parse(stdout) as JsonObject;
          }
          return [rawOut, jsonOut];
        } catch (e) {
          vscode.window.showErrorMessage(
            l10n.t("Failed to decrypt SOPS file to JSON")
          );
          console.error(e);
          throw e;
        }
      },
      {
        extension: this.sopsFormat,
      }
    );
    this.cachedTree = [stat, rawOut, jsonOut];
    return this.cachedTree;
  }

  private emitChanged = throttle(
    () => {
      if (this.fileChanges.length === 0) {
        this.addChangeEvent([], vscode.FileChangeType.Changed);
      }
      if (this.dataFilename) {
        this.addChangeEvent([this.dataFilename], vscode.FileChangeType.Changed);
      }
      const changes = this.fileChanges;
      this.fileChanges = [];
      this.onDidChangeEmitter.fire(changes);
    },
    100,
    {
      leading: false,
      trailing: true,
    }
  );

  private invalidateTreeCache() {
    this.cachedTree = null;
    this.emitChanged();
  }

  private async getTreeNode(path: string[]): Promise<TreeNode> {
    const [sopsStat, raw, tree] = await this.getTree();
    let type: vscode.FileType | null = null;
    let value: Uint8Array | null = null;
    let entries: [string, vscode.FileType][] = [];
    if (this.isDataFile(path)) {
      type = vscode.FileType.File;
      value = raw;
    } else if (tree) {
      const val = objectPath.get(tree, path);
      if (val === undefined) {
        throw vscode.FileSystemError.FileNotFound();
      }
      type = treeValueToType(val);

      if (type === vscode.FileType.Directory) {
        entries = Object.entries(val).map(([key, val]) => {
          return [key, treeValueToType(val)];
        });
      } else {
        value = Buffer.from(val.toString());
      }
    }

    if (path.length === 0 && this.dataFilename) {
      if (type && type !== vscode.FileType.Directory) {
        throw new Error("unreachable");
      }
      type = vscode.FileType.Directory;
      entries.unshift([this.dataFilename, vscode.FileType.File]);
    }

    let node: TreeNode;
    if (type === vscode.FileType.Directory) {
      node = {
        type,
        stat: {
          type,
          ctime: sopsStat.ctime,
          mtime: sopsStat.mtime,
          size: entries.length,
        },
        entries: entries as any,
      };
    } else if (type === vscode.FileType.File && value) {
      node = {
        type: vscode.FileType.File,
        stat: {
          type,
          ctime: sopsStat.ctime,
          mtime: sopsStat.mtime,
          size: value.byteLength,
        },
        value,
      };
    } else {
      throw vscode.FileSystemError.FileNotFound();
    }

    if (!this.watcher) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        this.sopsUri.fsPath
      );
      this.watcher = watcher;
      this.subscriptions.push(
        watcher.onDidCreate(() => {
          this.invalidateTreeCache();
        })
      );
      this.subscriptions.push(
        watcher.onDidChange(() => {
          this.invalidateTreeCache();
        })
      );
      this.subscriptions.push(
        watcher.onDidDelete(() => {
          this.invalidateTreeCache();
        })
      );
    }

    return node;
  }

  private async sopsCmdSet(
    sopsFile: string,
    path: string[],
    value: JsonValue
  ): Promise<void> {
    if (this.sopsFormat === SopsFormat.binary) {
      throw vscode.FileSystemError.NoPermissions(
        l10n.t("Set value on binary file is invalid")
      );
    }
    const [, , tree] = await this.getTree();

    const setPath = pathToSopsSetPath(path, tree || {});
    const jsonValue = JSON.stringify(value);
    try {
      await this.execSops(["--set", `${setPath} ${jsonValue}`, sopsFile], true);
    } catch (e) {
      vscode.window.showErrorMessage(
        l10n.t("Failed to set {path} on SOPS file", {
          path: setPath,
        })
      );
      console.error(e);
      throw e;
    }
  }

  private async sopsCmdRead(sopsFile: string): Promise<Buffer> {
    try {
      return await this.execSops(["--decrypt", sopsFile], false);
    } catch (e) {
      vscode.window.showErrorMessage(l10n.t("Failed to decrypt SOPS file"));
      console.error(e);
      throw e;
    }
  }

  private async sopsCmdWrite(
    sopsFile: string,
    content: Uint8Array
  ): Promise<void> {
    await temporaryFileTask(async (contentTemp) => {
      await fs.writeFile(contentTemp, content);
      const copyCmd =
        process.platform === "win32"
          ? `cmd.exe /c copy ${contentTemp}`
          : `cp ${contentTemp}`;
      try {
        await this.execSops([sopsFile], true, {
          ["EDITOR"]: copyCmd,
        });
      } catch (err: any) {
        const e = err as ExecaError;
        // https://pkg.go.dev/go.mozilla.org/sops/v3/cmd/sops/codes#FileHasNotBeenModified
        if (e.exitCode !== 200) {
          console.error("failed to edit sops file: ", e);
          throw e;
        }
      }
    });
  }

  private async withSopsFile<T>(
    f: (sopsFile: string) => Promise<T>
  ): Promise<T> {
    const sopsEncryptedContent = await vscode.workspace.fs.readFile(
      this.sopsUri
    );
    return await temporaryFileTask(
      async (sopsTemp) => {
        await fs.writeFile(sopsTemp, sopsEncryptedContent);
        return await f(sopsTemp);
      },
      {
        extension: this.sopsFormat,
      }
    );
  }

  private async addChangeEvent(path: string[], type: vscode.FileChangeType) {
    this.fileChanges.push({
      uri: vscode.Uri.from({
        scheme: "sops",
        path: "/" + path.join("/"),
      }),
      type,
    });
  }

  private async applySopsChange(sopsFile: string): Promise<void> {
    await vscode.workspace.fs.copy(vscode.Uri.file(sopsFile), this.sopsUri, {
      overwrite: true,
    });

    this.invalidateTreeCache();
  }

  watch(
    uri: vscode.Uri,
    options: {
      readonly recursive: boolean;
      readonly excludes: readonly string[];
    }
  ): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const node = await this.getTreeNode(uriToObjPath(uri));
    return node.stat;
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const node = await this.getTreeNode(uriToObjPath(uri));
    if (node.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotADirectory();
    }
    return node.entries;
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const path = uriToObjPath(uri);
    await this.withSopsFile(async (sopsTemp) => {
      await this.sopsCmdSet(sopsTemp, path, {});
      await this.applySopsChange(sopsTemp);
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const node = await this.getTreeNode(uriToObjPath(uri));
    if (node.type === vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileIsADirectory();
    }
    return node.value;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const path = uriToObjPath(uri);
    let parent: TreeNode | null = null;
    let node: TreeNode | null = null;
    try {
      parent = await this.getTreeNode(path.slice(0, -1));
    } catch (_) {}
    if (parent) {
      try {
        node = await this.getTreeNode(path);
      } catch (_) {}
    }

    if (!node && !options.create) {
      throw vscode.FileSystemError.FileNotFound();
    } else if (!parent && options.create) {
      throw vscode.FileSystemError.FileNotFound();
    } else if (node && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists();
    }

    await this.withSopsFile(async (sopsTemp) => {
      if (this.isDataFile(path)) {
        await this.sopsCmdWrite(sopsTemp, content);
      } else {
        await this.sopsCmdSet(sopsTemp, path, content.toString());
      }
      this.addChangeEvent(
        path,
        node ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created
      );
      await this.applySopsChange(sopsTemp);
    });
  }

  async delete(
    uri: vscode.Uri,
    _options: { readonly recursive: boolean }
  ): Promise<void> {
    const path = uriToObjPath(uri);
    await this.getTreeNode(path);
    if (this.isDataFile(path)) {
      throw vscode.FileSystemError.NoPermissions(
        l10n.t("Deletion of data file is forbidden")
      );
    }

    await this.withSopsFile(async (sopsTemp) => {
      await this.sopsCmdSet(sopsTemp, path, DELETED_MARKER);
      this.addChangeEvent(path, vscode.FileChangeType.Deleted);

      let newContent = await this.sopsCmdRead(sopsTemp);
      newContent = Buffer.from(
        deleteMarker(this.sopsFormat, newContent.toString())
      );
      await this.sopsCmdWrite(sopsTemp, newContent);

      await this.applySopsChange(sopsTemp);
    });
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const oldPath = uriToObjPath(oldUri);
    const newPath = uriToObjPath(newUri);
    const [, , tree] = await this.getTree();
    let newNode: TreeNode | null = null;

    await this.getTreeNode(oldPath);
    try {
      newNode = await this.getTreeNode(newPath);
    } catch (_) {}

    if (!options.overwrite && newNode) {
      throw vscode.FileSystemError.FileExists();
    }

    if (this.isDataFile(oldPath) || this.isDataFile(newPath)) {
      throw vscode.FileSystemError.NoPermissions(
        l10n.t("Renaming of data file is forbidden")
      );
    }
    if (!tree) {
      throw new Error("unreachable");
    }
    const value = objectPath.get(tree, oldPath);

    await this.withSopsFile(async (sopsTemp) => {
      await this.sopsCmdSet(sopsTemp, newPath, value);
      await this.sopsCmdSet(sopsTemp, oldPath, DELETED_MARKER);
      this.addChangeEvent(oldPath, vscode.FileChangeType.Deleted);
      this.addChangeEvent(
        newPath,
        newNode ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created
      );

      let newContent = await this.sopsCmdRead(sopsTemp);
      newContent = Buffer.from(
        deleteMarker(this.sopsFormat, newContent.toString())
      );
      await this.sopsCmdWrite(sopsTemp, newContent);

      await this.applySopsChange(sopsTemp);
    });
  }
}
