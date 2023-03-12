import vscode, { Disposable } from "vscode";
import LRUCache from "lru-cache";
import { SopsFs } from "./sopsfs";

function parseUri(uri: vscode.Uri): {
  sopsFile: vscode.Uri;
  fsUri: vscode.Uri;
} {
  const paths = uri.path.split("/").filter((i) => !!i);
  const uriEncoded = paths.shift();
  if (!uriEncoded) {
    throw vscode.FileSystemError.FileNotFound();
  }
  const sopsFile = vscode.Uri.parse(
    Buffer.from(uriEncoded, "base64url").toString()
  );

  const fsUri = vscode.Uri.from({
    ...uri,
    path: "/" + paths.join("/"),
  });

  return {
    sopsFile,
    fsUri,
  };
}

interface SopsFsProviderOpts {
  sopsCmd: string;
  env: Record<string, string>;
}

export class SopsFsProvider implements vscode.FileSystemProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  onDidChangeFile = this.onDidChangeEmitter.event;

  opts: SopsFsProviderOpts;

  constructor(opts?: Partial<SopsFsProviderOpts>) {
    this.opts = { sopsCmd: "sops", ...opts, env: { ...opts?.env } };
  }

  private fsCache = new LRUCache<string, [SopsFs, Disposable]>({
    max: 64,
    dispose([fs, listener]) {
      listener.dispose();
      fs.dispose();
    },
  });

  private async getOrOpenFs(uri: vscode.Uri): Promise<[SopsFs, vscode.Uri]> {
    const { sopsFile, fsUri } = parseUri(uri);
    const uriKey = sopsFile.toString();
    let fs = this.fsCache.get(uriKey)?.[0];
    if (!fs) {
      fs = new SopsFs({ ...this.opts, sopsUri: sopsFile });
      await fs.stat(vscode.Uri.from({ scheme: "sops", path: "/" }));

      const listener = fs.onDidChangeFile((events) => {
        const newEvents: vscode.FileChangeEvent[] = [];
        for (const e of events) {
          const uri = SopsFsProvider.composeUri(sopsFile, e.uri.path);
          // TODO: filter out uri that were not watched
          newEvents.push({
            type: e.type,
            uri,
          });
        }
        this.onDidChangeEmitter.fire(newEvents);
      });

      this.fsCache.set(uriKey, [fs, listener]);
    }
    return [fs, fsUri];
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
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      const res = await fs.stat(fsUri);
      return res;
    } catch (e) {
      console.error(`stat ${uri} ${fsUri}: ` + e);
      throw e;
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      const res = await fs.readDirectory(fsUri);
      return res;
    } catch (e) {
      console.error("readDir: " + e);
      throw e;
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      return await fs.createDirectory(fsUri);
    } catch (e) {
      console.error("createDir: " + e);
      throw e;
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      return await fs.readFile(fsUri);
    } catch (e) {
      console.error("readFile: " + e);
      throw e;
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      return await fs.writeFile(fsUri, content, options);
    } catch (e) {
      console.error("writeFile: " + e);
      throw e;
    }
  }

  async delete(
    uri: vscode.Uri,
    options: { readonly recursive: boolean }
  ): Promise<void> {
    const [fs, fsUri] = await this.getOrOpenFs(uri);
    try {
      return await fs.delete(fsUri, options);
    } catch (e) {
      console.error("delete: " + e);
      throw e;
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const { sopsFile: oldSops, fsUri: oldFsUri } = parseUri(oldUri);
    const { sopsFile: newSops, fsUri: newFsUri } = parseUri(newUri);
    if (oldSops.toString() !== newSops.toString()) {
      throw new Error(
        `cannot rename ${oldUri} to ${newUri}, not the same sops file`
      );
    }
    const [fs] = await this.getOrOpenFs(oldUri);
    try {
      return await fs.rename(oldFsUri, newFsUri, options);
    } catch (e) {
      console.error("rename: " + e);
      throw e;
    }
  }

  static composeUri(sopsFile: vscode.Uri, path?: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: "sops",
      path:
        "" +
        Buffer.from(sopsFile.toString()).toString("base64url") +
        (path || ""),
    });
  }
}
