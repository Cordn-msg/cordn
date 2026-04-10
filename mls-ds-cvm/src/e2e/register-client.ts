import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MlsDsCvmClient } from '../ctxcn/MlsDsCvmClient.js';

function uniqueIdentity(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function main(): Promise<void> {
  let exitCode = 0;
  const client = new MlsDsCvmClient({
    serverPubkey: MlsDsCvmClient.SERVER_PUBKEY,
    relays: MlsDsCvmClient.DEFAULT_RELAYS,
  });

  const stableIdentity = uniqueIdentity('e2e-alice');
  const deliveryAddresses = [uniqueIdentity('e2e-alice-device-1')];

  try {
    const registerResult = await client.RegisterClient(stableIdentity, deliveryAddresses);

    assert.ok(registerResult.registered, 'register_client did not report success');

    const listResult = await client.ListClients({});
    const registeredClient = listResult.clients.find((entry) => entry.stable_identity === stableIdentity);

    assert.ok(registeredClient, `registered client ${stableIdentity} was not returned by list_clients`);
    assert.deepEqual(registeredClient.delivery_addresses, deliveryAddresses);

    console.log(
      JSON.stringify(
        {
          stableIdentity,
          deliveryAddresses,
          registerResult,
          registeredClient,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    await client.disconnect();
    process.exit(exitCode);
  }
}

void main();
