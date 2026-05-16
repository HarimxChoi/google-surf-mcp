export type CaptchaMode = 'cloud_fail_fast' | 'remote_debug' | 'always_headed' | 'notify_spawn';

export function captchaModeFromConfig(cfg: {
  cloudMode: boolean;
  headless: boolean;
  remoteDebug: boolean;
}): CaptchaMode {
  if (cfg.cloudMode) return 'cloud_fail_fast';
  if (cfg.remoteDebug) return 'remote_debug';
  if (!cfg.headless) return 'always_headed';
  return 'notify_spawn';
}
