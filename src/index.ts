import { BashMcpServer } from './server/mcp-server.js';

function parseConfigPath(argv: string[]): string | undefined {
  const idx = argv.indexOf('--config');
  if (idx === -1 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

async function main(): Promise<void> {
  console.error('Model Context Protocol Server starting...');
  const configPath = parseConfigPath(process.argv.slice(2));
  const server = await BashMcpServer.create(configPath);
  await server.start();
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
