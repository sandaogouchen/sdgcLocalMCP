import { loadConfig } from '../config/default.js';
import { ToolService } from '../server/tool-service.js';
import { LocalBridgeAgent } from './local-agent.js';

function parseConfigPath(argv: string[]): string | undefined {
  const idx = argv.indexOf('--config');
  if (idx === -1 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  if (!config.localAgent?.enabled) {
    throw new Error('Local bridge agent is disabled in config');
  }

  const toolService = new ToolService(config);
  const agent = new LocalBridgeAgent(config.localAgent, toolService);
  await agent.start();
  console.log(`Local bridge agent connecting to ${config.localAgent.serverUrl}`);

  const shutdown = () => {
    void agent.stop().finally(() => {
      void toolService.stop().finally(() => process.exit(0));
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal local agent error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
