import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createInboundHandler, agentGate, CHANNEL } from './commands.js';
import { DigestService, resolveConfig } from './service.js';

export default definePluginEntry({
  id: 'arxiv-daily',
  name: 'arXiv Daily',
  description: 'Personal Weixin arXiv digest with deterministic commands and daily scheduling.',
  register(api) {
    let service;
    // Missing config is expected during installation/discovery. Hooks still fail closed.
    const raw = api.pluginConfig || {};
    const commandConfig = {allowedAccountIds: [], ...raw};
    api.on('before_dispatch', createInboundHandler(() => service, commandConfig, api.logger),
      {priority: 10000, registrationId: 'arxiv-daily-subscription-only', timeoutMs: 5000});
    api.on('before_agent_run', agentGate,
      {priority: 10000, registrationId: 'arxiv-daily-no-weixin-agent-turns'});
    api.registerService({
      id: 'arxiv-daily',
      reload: {configPrefixes: ['plugins.entries.arxiv-daily']},
      async start(context) {
        const config = resolveConfig(raw);
        if (typeof api.runtime.llm?.complete !== 'function') throw new Error('arxiv-daily needs OpenClaw 2026.9.6 runtime.llm.complete.');
        service = new DigestService({
          config, stateDir: context.stateDir, logger: context.logger,
          complete: params => api.runtime.llm.complete(params),
          send: async ({accountId, to, text, signal}) => {
            signal?.throwIfAborted();
            const adapter = await api.runtime.channel.outbound.loadAdapter(CHANNEL);
            if (!adapter?.sendText) throw new Error('weixin not configured: outbound adapter unavailable');
            signal?.throwIfAborted();
            return adapter.sendText({cfg: context.config, accountId, to, text, signal});
          },
        });
        service.start();
      },
      async stop() { if (service) await service.stop(); service = undefined; },
    });
  },
});
