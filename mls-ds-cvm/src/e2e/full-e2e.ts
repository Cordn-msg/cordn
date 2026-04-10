import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import { getPublicKey } from 'nostr-tools';
import { MlsDsCvmClient } from '../ctxcn/MlsDsCvmClient.js';
import { MlsActor } from './mls-actor.js';

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function makeServerKeypair(): { privateKey: string; publicKey: string } {
  const privateKeyBytes = randomBytes(32);
  const privateKey = Buffer.from(privateKeyBytes).toString('hex');
  const publicKey = getPublicKey(privateKeyBytes);
  return { privateKey, publicKey };
}

async function startServer(privateKey: string): Promise<ChildProcess> {
  const server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CVM_PRIVATE_KEY: privateKey,
      CVM_RELAY_URLS: MlsDsCvmClient.DEFAULT_RELAYS.join(','),
      MLS_DS_DB_PATH: ':memory:',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  server.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`e2e server exited early with code=${code} signal=${signal ?? 'null'}`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  return server;
}

async function main(): Promise<void> {
  let exitCode = 0;
  const serverKeypair = makeServerKeypair();
  const server = await startServer(serverKeypair.privateKey);
  const aliceClient = new MlsDsCvmClient({
    serverPubkey: serverKeypair.publicKey,
    relays: MlsDsCvmClient.DEFAULT_RELAYS,
  });
  const bobClient = new MlsDsCvmClient({
    serverPubkey: serverKeypair.publicKey,
    relays: MlsDsCvmClient.DEFAULT_RELAYS,
  });

  try {
    const bridgeInfo = await aliceClient.BridgeInfo({});
    assert.equal(bridgeInfo.database_path, ':memory:');

    const alice = await MlsActor.create(unique('alice'), unique('alice-device'));
    const bob = await MlsActor.create(unique('bob'), unique('bob-device'));

    await aliceClient.RegisterClient(alice.stableIdentity, [alice.deliveryAddress]);
    await bobClient.RegisterClient(bob.stableIdentity, [bob.deliveryAddress]);

    const alicePublication = await alice.exportPublication();
    const bobPublication = await bob.exportPublication();

    assert.equal((await aliceClient.PublishKeyPackages(alice.stableIdentity, [alicePublication])).published, 1);
    assert.equal((await bobClient.PublishKeyPackages(bob.stableIdentity, [bobPublication])).published, 1);

    const listedBobPackages = await aliceClient.GetKeyPackages(bob.stableIdentity);
    assert.equal(listedBobPackages.key_packages.length, 1);

    const consumedBob = await aliceClient.ConsumeKeyPackage(bob.stableIdentity);
    assert.equal(consumedBob.key_package.key_package_ref, bobPublication.key_package_ref);

    const group = await alice.createGroup(unique('group'));
    const addBob = await alice.createAddCommit(consumedBob.key_package.key_package);

    assert.equal(group.groupIdBase64Url, addBob.groupIdBase64Url);
    assert.equal(addBob.epoch, 1);

    await aliceClient.PutGroupRoute(addBob.groupIdBase64Url, addBob.epoch, [alice.deliveryAddress, bob.deliveryAddress]);
    await aliceClient.SendWelcome(bob.stableIdentity, consumedBob.key_package.key_package_ref, addBob.welcomeBytesBase64Url);

    const bobWelcomes = await bobClient.RecvWelcomes(bob.stableIdentity);
    assert.equal(bobWelcomes.welcomes.length, 1);
    assert.equal(bobWelcomes.welcomes[0]?.key_package_ref, consumedBob.key_package.key_package_ref);

    await bob.joinFromWelcome(bobWelcomes.welcomes[0]!.message_bytes, alice);

    await aliceClient.SendMessage(
      addBob.groupIdBase64Url,
      addBob.epoch,
      alice.deliveryAddress,
      [bob.deliveryAddress],
      addBob.commitBytesBase64Url,
    );

    const bobCommitMessages = await bobClient.RecvMessages(bob.deliveryAddress);
    assert.equal(bobCommitMessages.messages.length, 1);
    await bob.processCommit(bobCommitMessages.messages[0]!.message_bytes);

    const aliceText = 'hello bob from alice';
    const aliceMessage = await alice.createApplicationMessage(aliceText);
    await aliceClient.SendMessage(
      addBob.groupIdBase64Url,
      aliceMessage.epoch,
      alice.deliveryAddress,
      [bob.deliveryAddress],
      aliceMessage.messageBytesBase64Url,
    );

    const bobMessages = await bobClient.RecvMessages(bob.deliveryAddress);
    assert.equal(bobMessages.messages.length, 1);
    const receivedByBob = await bob.processApplicationMessage(bobMessages.messages[0]!.message_bytes);
    assert.equal(receivedByBob, aliceText);

    const bobText = 'hello alice from bob';
    const bobReply = await bob.createApplicationMessage(bobText);
    await bobClient.SendMessage(
      addBob.groupIdBase64Url,
      bobReply.epoch,
      bob.deliveryAddress,
      [alice.deliveryAddress],
      bobReply.messageBytesBase64Url,
    );

    const aliceMessages = await aliceClient.RecvMessages(alice.deliveryAddress);
    assert.equal(aliceMessages.messages.length, 1);
    const receivedByAlice = await alice.processApplicationMessage(aliceMessages.messages[0]!.message_bytes);
    assert.equal(receivedByAlice, bobText);

    console.log(
      JSON.stringify(
        {
          groupId: addBob.groupIdBase64Url,
          epoch: bobReply.epoch,
          alice: {
            stableIdentity: alice.stableIdentity,
            deliveryAddress: alice.deliveryAddress,
          },
          bob: {
            stableIdentity: bob.stableIdentity,
            deliveryAddress: bob.deliveryAddress,
          },
          messages: {
            aliceToBob: receivedByBob,
            bobToAlice: receivedByAlice,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    await Promise.allSettled([aliceClient.disconnect(), bobClient.disconnect()]);
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
    process.exit(exitCode);
  }
}

void main();
