import { ApplesauceRelayPool } from "@contextvm/sdk";
import { connectServer } from "./coordinatorServer.ts";
import {
  createConfiguredCoordinator,
  loadRuntimeEnv,
  readServerRuntimeConfig,
} from "./runtimeConfig.ts";

async function main(): Promise<void> {
  loadRuntimeEnv();
  const runtime = readServerRuntimeConfig();

  await connectServer({
    coordinator: createConfiguredCoordinator(runtime.storage),
    signer: runtime.signer,
    relayHandler: new ApplesauceRelayPool(runtime.relayUrls),
    serverInfo: runtime.serverInfo,
    isAnnouncedServer: runtime.isAnnouncedServer,
  });

  console.log("ContextVM MLS coordinator server connected");
  console.log("relays:", runtime.relayUrls.join(", "));
  console.log("announced:", runtime.serverInfo.name, runtime.isAnnouncedServer);
  console.log(
    "storage:",
    runtime.storage.backend,
    runtime.storage.sqlitePath ?? "",
  );
}

main().catch((error: unknown) => {
  console.error("Failed to start ContextVM MLS coordinator server");
  console.error(error);
  process.exit(1);
});
