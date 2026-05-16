import { spawn } from 'node:child_process';
import { platform } from 'node:os';

function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      p.on('error', () => resolve());
      p.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function osNotify(title: string, body: string): Promise<void> {
  const t = title.slice(0, 80);
  const b = body.slice(0, 200);
  switch (platform()) {
    case 'darwin': {
      const script = `display notification "${escapeAppleScript(b)}" with title "${escapeAppleScript(t)}"`;
      return spawnDetached('osascript', ['-e', script]);
    }
    case 'win32': {
      const escT = t.replace(/'/g, "''");
      const escB = b.replace(/'/g, "''");
      const ps = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null;`
        + `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;`
        + `$xml.LoadXml("<toast><visual><binding template='ToastText02'><text id='1'>${escT}</text><text id='2'>${escB}</text></binding></visual></toast>");`
        + `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml;`
        + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('google-surf-mcp').Show($toast)`;
      return spawnDetached('powershell.exe', ['-NoProfile', '-Command', ps]);
    }
    default: {
      return spawnDetached('notify-send', ['-u', 'critical', t, b]);
    }
  }
}
