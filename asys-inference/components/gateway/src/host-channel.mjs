import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import { AuthenticationMethod } from '@cyclo/gateway-protocol/contract';
import { providerCatalogueDocument } from '@cyclo/provider/http';
import { Reader, Writer, directionRoot } from '../../vendor/asys-runtime/channel.mjs';
import { gatewayAuthOptionSupported } from './login.mjs';
import { createAuthInteraction } from './oauth-ui.mjs';
import { usageDocument } from './http.mjs';

// Authentication remains inside this component. Only its user interaction is
// transported: request -> notices/prompts -> answers -> result (or error).
export async function serveGatewayChannel(services, root, { signal, idleTimeoutMs = 15_000, onReady } = {}) {
  const failed = new AbortController();
  const stopping = new AbortController();
  const shutdown = AbortSignal.any([...(signal ? [signal] : []), failed.signal, stopping.signal]);
  const input = new Reader(directionRoot(root, 'gateway', 'in'));
  const checkpoints = new Writer(input.directory);
  const output = new Writer(directionRoot(root, 'gateway', 'out'));
  const instance = randomUUID();
  const active = new Map();
  const seen = new Set();
  const fatal = error => failed.abort(error);
  const send = (type, data) => {
    const pending = output.send(type, { ...data, instance });
    void pending.catch(fatal);
    return pending;
  };

  // A restarted gateway cannot resume a provider's in-memory OAuth exchange.
  // Do not replay an earlier process's commands or secrets. Clients observe
  // the new instance and report interruption instead of silently retrying.
  const checkpoint = await checkpoints.send('consumed', { instance });
  await input.advance(checkpoint.sequence);
  await input.prune();
  await send('ready', { instance });
  onReady?.();

  async function ask(session, message, secret, promptSignal) {
    promptSignal.throwIfAborted();
    const prompt = randomUUID();
    let resolve, reject;
    const answer = new Promise((yes, no) => { resolve = yes; reject = no; });
    void answer.catch(() => {});
    const cancel = () => {
      void send('prompt.cancelled', { id: session.id, prompt });
      reject(promptSignal.reason);
    };
    session.prompts.set(prompt, resolve);
    promptSignal.addEventListener('abort', cancel, { once: true });
    try {
      await send('prompt', { id: session.id, prompt, message, secret });
      return await answer;
    } finally {
      promptSignal.removeEventListener('abort', cancel);
      session.prompts.delete(prompt);
    }
  }

  async function execute(session, command, body) {
    const context = { signal: AbortSignal.any([shutdown, session.cancel.signal]) };
    context.interaction = createAuthInteraction({
      signal: context.signal,
      ask: (question, signal) => ask(session, question, false, signal),
      askSecret: (question, signal) => ask(session, question, true, signal),
      write: message => { void send('notice', { id: session.id, message }); },
      allowOption: option => gatewayAuthOptionSupported(body.provider, option),
    });
    try {
      const result = await gatewayCommand(services, command, body, context);
      await send('result', { id: session.id, result });
    } catch (error) {
      if (failed.signal.aborted) throw error;
      const message = context.signal.aborted ? 'Gateway request cancelled'
        : error instanceof ConnectError && error.code !== Code.Internal ? error.rawMessage
          : 'Gateway operation failed';
      await send('error', { id: session.id, message });
    } finally {
      session.cancel.abort();
      active.delete(session.id);
    }
  }

  const expiry = setInterval(() => {
    for (const session of active.values()) {
      if (Date.now() - session.lastSeen > idleTimeoutMs) session.cancel.abort();
    }
  }, Math.min(1000, idleTimeoutMs));
  try {
    for await (const event of input.follow(undefined, { signal: shutdown })) {
      const data = event.data ?? {};
      let answer;
      if (event.type === 'request' && typeof data.id === 'string' && data.id && !seen.has(data.id)) {
        seen.add(data.id);
        if (data.instance !== instance) {
          await send('error', { id: data.id, message: 'Gateway restarted; retry the command' });
        } else {
          const session = { id: data.id, cancel: new AbortController(), prompts: new Map(), lastSeen: Date.now() };
          active.set(data.id, session);
          await send('accepted', { id: data.id, instance });
          session.running = execute(session, data.command, data.body ?? {});
          void session.running.catch(fatal);
        }
      } else {
        const session = active.get(data.id);
        if (session) {
          if (event.type === 'keepalive') {
            session.lastSeen = Date.now();
            await send('alive', { id: data.id });
          }
          if (event.type === 'cancel') session.cancel.abort();
          if (event.type === 'answer' && typeof data.value === 'string') {
            session.lastSeen = Date.now();
            answer = session.prompts.get(data.prompt);
          }
        }
        // All answers, including stale ones, are transient. Append a harmless
        // high-water mark so pruning can also remove the latest secret file.
        if (event.type === 'answer') await checkpoints.send('consumed', { id: data.id });
      }
      await input.advance(event.sequence);
      await input.prune();
      answer?.(data.value);
    }
  } catch (error) {
    if (failed.signal.aborted) throw failed.signal.reason;
    if (!signal?.aborted) throw error;
  } finally {
    clearInterval(expiry);
    stopping.abort();
    await Promise.allSettled([...active.values()].map(session => session.running));
  }
}

export async function gatewayCommand(services, command, body, context) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Request body must be an object');
  switch (command) {
    case 'status':
      fields(body, []);
      return services.status.getStatus({}, context);
    case 'models':
      fields(body, []);
      return providerCatalogueDocument(await services.provider.listModels({}, context));
    case 'providers': {
      fields(body, []);
      const { providers = [] } = await services.discovery.listProviders({}, context);
      return { providers: providers.map(p => ({ id: p.id, description: p.description, oauth: p.oauth, api_key: p.apiKey })) };
    }
    case 'usage': {
      fields(body, []);
      const value = await services.usage.getUsage({}, context);
      return usageDocument(value);
    }
    case 'login': {
      fields(body, ['provider', 'account', 'authentication', 'interactive', 'api_key_input']);
      const authentication = { auto: AuthenticationMethod.UNSPECIFIED, oauth: AuthenticationMethod.OAUTH, api_key: AuthenticationMethod.API_KEY }[body.authentication];
      if (authentication === undefined) invalid('Authentication must be auto, oauth, or api_key');
      if (typeof body.interactive !== 'boolean') invalid('Interactive must be a boolean');
      if (body.api_key_input !== undefined && typeof body.api_key_input !== 'boolean') invalid('API-key input must be a boolean');
      context.apiKeyInput = body.api_key_input ?? false;
      const result = await services.admin.login({ provider: string(body.provider, 'Provider'),
        account: body.account === undefined ? '' : string(body.account, 'Account', true), authentication, interactive: body.interactive }, context);
      const method = { [AuthenticationMethod.OAUTH]: 'oauth', [AuthenticationMethod.API_KEY]: 'api_key' }[result.authentication];
      if (!method) throw new Error('No authentication result');
      return { account: result.account, authentication: method };
    }
    case 'logout': {
      fields(body, ['account']);
      return services.admin.logout({ account: string(body.account, 'Account') }, context);
    }
    case 'rename': {
      fields(body, ['account', 'new_account']);
      const result = await services.admin.rename({ account: string(body.account, 'Account'), newAccount: string(body.new_account, 'New account') }, context);
      return { account: result.account, new_account: result.newAccount };
    }
    default: invalid('Unknown gateway command');
  }
}

function invalid(message) { throw new ConnectError(message, Code.InvalidArgument); }
function fields(body, names) { if (Object.keys(body).some(key => !names.includes(key))) invalid('Unknown request field'); }
function string(value, label, empty = false) { if (typeof value !== 'string' || (!empty && !value)) invalid(`${label} must be a string`); return value; }
