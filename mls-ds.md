MLS uses a **Delivery Service (DS)**—often called the coordinator or server—to facilitate group operations without accessing keys or contents. It's not strictly an HTTP server but typically implemented over HTTP/HTTPS (or WebSockets) atop TLS for transport, as per the MLS architecture (RFC 9420). [architecture.messaginglayersecurity](https://architecture.messaginglayersecurity.rocks)

## Delivery Service Role
The DS acts as a **message relay and queue** for three core functions:
- **Proposal queuing**: Clients POST encrypted proposals (e.g., "add user X") to the DS, tagged with a group ID; it stores and forwards them to group members without decrypting.
- **Commit processing**: Clients send commits (e.g., applying proposals via TreeKEM updates) to the DS, which broadcasts the updated group state (encrypted handshake) to all members.
- **Application message fan-out**: Opaque app messages are sent to the DS, which delivers them to current group members based on the latest epoch/group state.

Clients poll or use push for fetches; the DS knows current membership from public group state but can't join or decrypt. This keeps crypto end-to-end while enabling scale. [theseus](https://www.theseus.fi/bitstream/handle/10024/748768/Krishnan_Adarsh.pdf?sequence=2)

## Transport and Protocols
- **HTTP-based by convention**: Most libs (OpenMLS, ts-mls) use RESTful HTTP APIs (POST /groups/{group_id}/proposals, etc.) over TLS 1.3+. Direct P2P (WebRTC) is possible without DS for small groups, but DS is standard for large-scale. [positive-intentions](https://positive-intentions.com/blog/mls-group-messaging/)
- No fixed wire format beyond abstract MLS messages; often serialized via CBOR/Protobuf over HTTP bodies.

## Group IDs in Headers
**Yes, MLS messages include stable Group IDs** in plaintext headers for routing:
- **Framed messages** start with: Group ID (32 bytes, app-chosen or random), Epoch (u64), Content Type, and Sender (opaque).
- DS uses Group ID to queue/route (e.g., POST to /groups/{group_id}); it's visible to servers, leaking "who talks in which group" metadata unless obfuscated (e.g., via ephemeral IDs or padding).
- **Mitigations**: MLS1.1+ extensions encrypt headers; apps layer Tor/onion routing. Still, base MLS exposes Group ID/Epoch to DS for functionality. [book.openmls](https://book.openmls.tech/user_manual/processing.html)

| Component | Signal Equivalent | MLS DS |
|-----------|-------------------|--------|
| Protocol | Proprietary fan-out | RFC 9420 DS |
| Visibility | Sender/group IDs | Group ID/epoch in header |
| Decryption | None (opaque) | None (opaque) |
| Scalability | O(1) send | O(log N) + DS relay |

This design trades some metadata for efficiency; pure P2P avoids it but doesn't scale. [positive-intentions](https://positive-intentions.com/blog/mls-group-messaging/)
Yes, several open-source MLS Delivery Service (DS) implementations exist, primarily as proof-of-concepts or production-ready components integrated with MLS libraries like OpenMLS. They typically use HTTP/gRPC over TLS, with some supporting WebSockets for real-time push. [github](https://github.com/jdbohrman-tech/hermetic-mls)

## Key Open-Source DS Projects
- **Hermetic-MLS** (Rust/gRPC): Full-featured DS using OpenMLS rust library, with PostgreSQL persistence for groups, keypackages, and messages. Handles client registration, proposals, commits; production-ready with SQLx. GitHub: jdbohrman-tech/hermetic-mls. [github](https://github.com/jdbohrman-tech/hermetic-mls)
- **OpenMLS DS** (Rust): Matrix.org's proof-of-concept in GitLab (gitlab.matrix.org/uhoreg/openmls), supports client registration and basic MLS ops (proposals/commits). HTTP-based, aimed at testing MLS in Matrix. [gitlab.matrix](https://gitlab.matrix.org/uhoreg/openmls/-/tree/konrad/treesync-implementation/delivery-service/ds)
- **r2ishiguro/mls** (Go): Early DS ("mlsds") with BFT storage; builds via `go build mlsds.go`. Simple command-line server for keypair setup and message relay. GitHub: r2ishiguro/mls. [github](https://github.com/r2ishiguro/mls)

## WebSockets Support
No core DS mandates WebSockets, but they're feasible atop HTTP:
- **Common pattern**: HTTP polling for proposals/messages (POST /groups/{id}/fetch), with WebSockets for push notifications (e.g., new commit available). Libraries like ws (Node.js) or Tokio-tungstenite (Rust) integrate easily.
- **Examples**: Hermetic-MLS could extend to WebSockets via tonic-web for browser clients; Matrix explorations often prototype WebSocket bridges since Matrix uses them natively. Pure WebSocket DS exists in prototypes but favors gRPC/HTTP for RFC compliance. [render](https://render.com/articles/building-real-time-applications-with-websockets)

| Project | Language | Transport | Maturity |
|---------|----------|-----------|----------|
| Hermetic-MLS | Rust | gRPC/HTTP | Production |
| OpenMLS DS | Rust | HTTP | PoC/Test |
| r2ishiguro/mls | Go | HTTP | Basic |

These pair with OpenMLS (Rust) or other MLS libs (Cisco's C++). Start with Hermetic-MLS for scalable deployments; extend with WebSockets if low-latency push is needed. [theseus](https://www.theseus.fi/bitstream/handle/10024/748768/Krishnan_Adarsh.pdf?sequence=2)