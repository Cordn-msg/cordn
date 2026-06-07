import { ApplesauceRelayPool } from '@contextvm/sdk';
import pino from 'pino';
import { connectServer } from './coordinatorServer.ts';
import {
	createConfiguredCoordinator,
	loadRuntimeEnv,
	readServerRuntimeConfig
} from './runtimeConfig.ts';

async function main(): Promise<void> {
	loadRuntimeEnv();
	const runtime = readServerRuntimeConfig();
	const logger = pino({ name: 'cordn-server' });
	const serverPubkey = await runtime.signer.getPublicKey();

	logger.info(
		{ serverPubkey },
		'🔑 THIS IS YOUR SERVER PUBLIC KEY — clients must target this Nostr pubkey to reach this server'
	);

	await connectServer({
		coordinator: createConfiguredCoordinator(runtime.storage, runtime.welcomeTtl),
		abuseProtection: runtime.abuseProtection,
		logger,
		signer: runtime.signer,
		relayHandler: new ApplesauceRelayPool(runtime.relayUrls),
		serverInfo: runtime.serverInfo,
		isAnnouncedServer: runtime.isAnnouncedServer
	});

	logger.info(
		{
			relays: runtime.relayUrls,
			announced: runtime.isAnnouncedServer,
			serverName: runtime.serverInfo.name,
			storageBackend: runtime.storage.backend,
			sqlitePath: runtime.storage.sqlitePath,
			serverPubkey
		},
		'ContextVM MLS coordinator server connected'
	);
}

main().catch((error: unknown) => {
	pino({ name: 'cordn-server' }).error(
		{ error },
		'Failed to start ContextVM MLS coordinator server'
	);
	process.exit(1);
});
