# vscode-sops-fs

VS Code [SOPS](https://github.com/mozilla/sops) virtual filesystem extension.

## Usage

0. Prepend `.sops` to SOPS file extension so the extension can recognize the file as SOPS, e.g.

- `foo.json` => `foo.sops.json`
- `bar.yaml` => `bar.sops.yaml`
- `binary` => `binary.sops`

To associate other filenames to language ID `sops`, config `files.associations` in your settings.

1. Right click on SOPS filename or active editor to mount SOPS file as workspace folder

> **Note**
> To unmount the SOPS file, just right click created workspace folder and remove the folder from workspace.
> Note changes to SOPS virtual filesystem would be written to original SOPS file on save, no unmount is required.

The SOPS file would now be decrypted and listed in mounted folder, with each file or sub-folder mapping to leaf property or dictionary in SOPS file.

You are free to read, write, rename, delete, mkdir on those files.

And with the special file `__sops__.<basename>` corresponding to direct output from decryption of SOPS file, only read & write operations are available for this file.
