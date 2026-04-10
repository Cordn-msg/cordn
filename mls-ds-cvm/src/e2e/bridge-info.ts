import assert from 'node:assert/strict';
import { MlsDsCvmClient } from '../ctxcn/MlsDsCvmClient.js';

async function main(): Promise<void> {
  let exitCode = 0;
  const client = new MlsDsCvmClient({
    serverPubkey: MlsDsCvmClient.SERVER_PUBKEY,
    relays: MlsDsCvmClient.DEFAULT_RELAYS,
  });

  try {
    const result = await client.BridgeInfo({});

    assert.ok(result, 'bridge_info returned no result');
    assert.ok(result.status === 'ok' || result.status === 'ready');
    assert.equal(result.contract, 'plans/mls-ds-api-contract.md');
    assert.equal(result.bridge, 'stdin-stdout-json');
    assert.equal(result.database_path, ':memory:');

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    await client.disconnect();
    process.exit(exitCode);
  }
}

void main();
