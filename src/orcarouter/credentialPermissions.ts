import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function setWindowsCredentialAcl(file: string): void {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = [Security.AccessControl.FileSecurity]::new()',
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true, $false)',
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')",
    '$acl.AddAccessRule($rule)',
    '[IO.File]::SetAccessControl($env:SURF_ORCA_PRIVATE_FILE, $acl)',
  ].join('\n');
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 5_000, stdio: 'pipe', env: {
      ...process.env, SURF_ORCA_PRIVATE_FILE: file,
    } });
}
