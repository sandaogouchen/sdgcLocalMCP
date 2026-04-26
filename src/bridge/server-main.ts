import { loadConfig } from '../config/default.js';
import { ToolService } from '../server/tool-service.js';
import { BridgePublicServer } from './public-server.js';

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
  if (!config.bridge?.enabled) {
    throw new Error('Bridge server is disabled in config');
  }

  const toolService = new ToolService(config);
  const server = new BridgePublicServer(config.bridge, toolService);
  await server.start();
  console.log(`Bridge public server listening on ${config.bridge.host}:${config.bridge.port}`);

  const shutdown = () => {
    void server.stop().finally(() => {
      void toolService.stop().finally(() => process.exit(0));
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal bridge server error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
