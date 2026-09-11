// `google-surf-mcp orcarouter …` — the two credential entry points users can
// discover from the command line, plus the model catalog both of them feed.
//
//   orcarouter login     Paste an existing sk-orca-… key (API-key adapter)
//   orcarouter connect   OAuth 2.0 + PKCE (PKCE adapter); --oob for Flow B
//   orcarouter status    Which credential is active, and its state
//   orcarouter logout    Clear the stored PKCE credential
//   orcarouter models    Real catalog for one capability, from the configured origin

import { createInterface } from 'node:readline/promises';
import {
  apiKeyProvider,
  clearStoredCredential,
  credentialGeneration,
  credentialsPathHint,
  loadStoredCredential,
  looksLikeOrcaKey,
  needsReauth,
  pkceProvider,
  readReauthState,
  redactKey,
  resolveCredential,
  saveApiKeyCredential,
} from '../orcarouter/credentials.js';
import { resolveEndpoints } from '../orcarouter/endpoints.js';
import {
  connectLoopback,
  connectOutOfBand,
  type ConnectResult,
} from '../orcarouter/pkce.js';
import {
  discoverModels,
  filterByCapability,
  type OrcaCapability,
} from '../orcarouter/models.js';

const APP_NAME = 'Google Surf MCP';
const USAGE = `usage: orcarouter <command>

  login [--key <sk-orca-…>]   Save an existing OrcaRouter API key
  connect [--oob]             Authorize with an OrcaRouter account (OAuth 2.0 + PKCE)
  models [--capability <c>]   List models from the configured catalog
  ui                          Serve the OrcaRouter configuration page on 127.0.0.1
  status                      Show which credential is active
  logout                      Remove the stored PKCE credential

Capabilities: chat, embedding, image, video, rerank
Set ORCA_AUTH_BASE_URL / ORCA_API_BASE_URL to point at a self-hosted deployment.

PKCE flows: A (loopback redirect) is the default and is used by "connect".
B (out-of-band code) is used by "connect --oob". Flow C (device grant,
RFC 8628) is available from the OrcaRouter auth API but is intentionally not
implemented here: this client runs where a browser or a copyable code is
already available, so the extra polling surface would add no reachable user.`;

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
}

/** Print the authorize URL so a browser that does not open can still be used. */
function announceAuthorizeUrl(url: string): void {
  process.stdout.write(`\nOpen this URL to authorize ${APP_NAME}:\n${url}\n\n`);
}

function reportConnect(result: ConnectResult): void {
  // The key itself is never printed — only its fingerprint.
  process.stdout.write(
    `Connected. Stored an OrcaRouter key (${redactKey(result.key)}, generation ${credentialGeneration(result.key)}).\n`,
  );
  if (result.scopeDowngraded) {
    process.stdout.write(
      `Note: the granted scope is "${result.scope}", not the "api" scope that was requested.\n`
      + 'The workspace role does not permit the wider grant, so only the granted scope is stored.\n',
    );
  }
}

function describeConnectFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Errors are already redacted at the source; this is a second line of defence
  // against a verifier or code reaching the terminal.
  return message.replaceAll(/(code|code_verifier)=[^\s&"']+/gi, '$1=[redacted]');
}

async function login(args: string[]): Promise<number> {
  const flagIndex = args.indexOf('--key');
  let key = flagIndex >= 0 ? args[flagIndex + 1]?.trim() : undefined;
  if (!key) key = (await prompt('OrcaRouter API key (sk-orca-…): ')).trim();
  if (!key) {
    process.stderr.write('No key entered.\n');
    return 1;
  }
  if (!looksLikeOrcaKey(key)) {
    // Format check only: the prefix is not proof the credential is valid, and
    // there is no non-billing validation request, so validity stays unknown
    // until the first real request.
    process.stdout.write('Warning: this does not look like an sk-orca-… key. Saving it anyway.\n');
  }
  saveApiKeyCredential(key, 'api');
  process.stdout.write(
    `Saved (${redactKey(key)}, generation ${credentialGeneration(key)}) to ${credentialsPathHint()}.\n`
    + 'Manage or revoke keys at https://www.orcarouter.ai/console/authorized-apps\n',
  );
  return 0;
}

async function connect(args: string[]): Promise<number> {
  const endpoints = resolveEndpoints();
  const oob = args.includes('--oob');
  try {
    const result = oob
      ? await connectOutOfBand({
        appName: APP_NAME,
        onAuthorizeUrl: announceAuthorizeUrl,
        readCode: () => prompt('Authorization code shown on the consent screen: '),
      }, endpoints)
      : await connectLoopback({ appName: APP_NAME, onAuthorizeUrl: announceAuthorizeUrl }, endpoints);
    reportConnect(result);
    return 0;
  } catch (error) {
    process.stderr.write(`Connect failed: ${describeConnectFailure(error)}\n`);
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'rate_limited') {
      process.stderr.write('Reuse the stored key instead of reconnecting.\n');
    }
    return 1;
  }
}

async function models(args: string[]): Promise<number> {
  const flagIndex = args.indexOf('--capability');
  const capability = (flagIndex >= 0 ? args[flagIndex + 1] : 'chat') as OrcaCapability | undefined;
  const credential = await resolveCredential();
  const endpoints = resolveEndpoints();
  const selected = capability ?? 'chat';
  // Each capability asks for its own catalog slice.
  const catalog = await discoverModels({ endpoints, apiKey: credential?.key, capability: selected });
  const models = filterByCapability(catalog.models, selected);

  process.stdout.write(`catalog: ${catalog.source}${catalog.degraded ? ` (degraded: ${catalog.reason})` : ''}\n`);
  process.stdout.write(`capability: ${selected} — ${models.length} model(s)\n`);
  for (const model of models) {
    const flags = [
      model.metadata.reasoning ? `reasoning:${model.metadata.reasoningEfforts.join('/') || 'yes'}` : '',
      model.metadata.inputModalities.length ? `input:${model.metadata.inputModalities.join(',')}` : '',
      model.metadata.contextLength ? `ctx:${model.metadata.contextLength}` : '',
    ].filter(Boolean).join(' ');
    process.stdout.write(`  ${model.id}${flags ? `  [${flags}]` : ''}\n`);
  }
  return catalog.status === 'ok' ? 0 : 2;
}

async function status(): Promise<number> {
  const credential = await resolveCredential();
  if (!credential) {
    process.stdout.write('No OrcaRouter credential is configured.\n');
    process.stdout.write('  api key : set ORCAROUTER_API_KEY (or run: orcarouter login)\n');
    process.stdout.write('  account : run: orcarouter connect\n');
    return 1;
  }
  const reauth = readReauthState();
  const stale = needsReauth(credential);
  process.stdout.write(`source    : ${credential.source}\n`);
  process.stdout.write(`key       : ${redactKey(credential.key)} (generation ${credential.generation})\n`);
  process.stdout.write(`scope     : ${credential.scope}\n`);
  if (credential.accountId) process.stdout.write(`account   : ${credential.accountId}\n`);
  process.stdout.write(`state     : ${stale ? 'needsReauth' : 'ok'}\n`);
  if (stale && reauth) process.stdout.write(`marked at : ${reauth.markedAt}\n`);
  return stale ? 3 : 0;
}

async function logout(): Promise<number> {
  const had = loadStoredCredential() !== null;
  clearStoredCredential();
  process.stdout.write(had ? 'Removed the stored PKCE credential.\n' : 'No stored PKCE credential to remove.\n');
  if (await apiKeyProvider().resolve()) {
    process.stdout.write('Note: ORCAROUTER_API_KEY is still set and remains the active credential.\n');
  }
  return 0;
}

async function ui(): Promise<number> {
  const { startUiServer } = await import('./ui.js');
  const handle = await startUiServer();
  process.stdout.write(`OrcaRouter configuration: ${handle.url}\nPress Ctrl+C to stop.\n`);
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { void handle.close().then(resolve); });
    process.on('SIGTERM', () => { void handle.close().then(resolve); });
  });
  return 0;
}

export async function runOrcaRouterCli(args: string[]): Promise<void> {
  const [command] = args;
  switch (command) {
    case 'login': process.exitCode = await login(args.slice(1)); return;
    case 'connect': process.exitCode = await connect(args.slice(1)); return;
    case 'models': process.exitCode = await models(args.slice(1)); return;
    case 'ui': process.exitCode = await ui(); return;
    case 'status': process.exitCode = await status(); return;
    case 'logout': process.exitCode = await logout(); return;
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}

// Re-exported so the MCP `health` surface and tests share one resolver.
export { pkceProvider };
