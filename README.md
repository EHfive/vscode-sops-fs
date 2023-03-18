# SOPS Virtual Filesystem

VS Code [SOPS](https://github.com/mozilla/sops) virtual filesystem extension.

<details>
  <summary>Show Demo Video</summary>

https://user-images.githubusercontent.com/24871166/224997543-886de0d0-f8ff-4d36-a71c-df399d447094.mp4

</details>

### Features
- Transparent decryption and re-encryption of SOPS file.
- Mapping SOPS entries to individual virtual files.
- Allows non-trivial text format for each entry in SOPS file so you can enjoy syntax highlighting & formatting powered by VS Code ecosystem.

## Install

| Marketplace               | Extension                                                               |
| ------------------------- | ----------------------------------------------------------------------- |
| Visual Studio Marketplace | [eh5.vscode-sops-fs](https://open-vsx.org/extension/eh5/vscode-sops-fs) |
| Open VSX Registry         | [eh5.vscode-sops-fs](https://open-vsx.org/extension/eh5/vscode-sops-fs) |

### Requirements

- `sops` in `PATH`
- Recent VS Code that supports [l10n](https://code.visualstudio.com/api/references/vscode-api#l10n) API

## Usage

Insert `.sops` to SOPS filename so the extension can recognize the file as SOPS, e.g.

- `foo.json` => `foo.sops.json`
- `bar.yaml` => `bar.sops.yaml`
- `binary` => `binary.sops`

Alternatively tweak `files.associations` in your settings to associate arbitrary filenames to language ID `sops`.

```json
{
  "files.associations": {
    "foobar.mysops.json": "sops"
  }
}
```

Then right click on SOPS filename or the active editor to mount SOPS file as workspace folder.

> **Note**
> To unmount the SOPS file, just right click on created workspace folder and select remove the folder from workspace.
> Note that changes to SOPS virtual filesystem would be written to original SOPS file on save, no unmount is required.

The SOPS file would now be decrypted and listed in mounted folder, with each file or sub-folder mapping to leaf property or dictionary in SOPS file.

You are free to read, write, rename, delete on those files and create folders.

Additionally with the special file `__sopsfs__.<extname>` corresponding to direct decryption output of SOPS file, only read & write operations are available for this file.

### Custom Decryption Keys

Configure `sopsfs.env` in settings to pass SOPS environment variables for keys. See [Usage](https://github.com/mozilla/sops#id6) section in SOPS README.

```json
{
  "sopsfs.env": {
    "SOPS_AGE_KEY_FILE": "/path/to/age/key.txt"
  }
}
```

See also demo [settings](demo/.vscode/settings.json).

## Development

> **Note**
> This section is for developers, end-users don't have to read this.

### URI Schema

`sops:/<base64url encoded SOPS URI>/<path>`

- `<base64url encoded SOPS URI>`

[base64url](https://nodejs.org/api/buffer.html#buffers-and-character-encodings) encoded URI of SOPS file, which is going to be accessed.

For example, given a URI `file:///home/alice/project/secrets.yaml` it has `<base64url encoded SOPS URI>` of `ZmlsZTovLy9ob21lL2FsaWNlL3Byb2plY3Qvc2VjcmV0cy55YW1s`.

```javascript
> Buffer.from("file:///home/alice/project/secrets.yaml").toString("base64url")
'ZmlsZTovLy9ob21lL2FsaWNlL3Byb2plY3Qvc2VjcmV0cy55YW1s'
```

As we use [vscode.workspace.fs](https://code.visualstudio.com/api/references/vscode-api#FileSystem) API instead of native `fs` module to access files, the URI can be any type of schemas registered.

- `<path>`

Virtual filesystem path mapping to property tree of SOPS file.

For example, given a property path `foo.bar.prop` it has `<path>` of `foo/bar/prop`.
