---
"cordn": patch
---

feat(coordinator): add SubscribeManyGroupMessages API for multi-group streaming

Add a new `SubscribeManyGroupMessages` method that allows clients to subscribe to messages from multiple groups in a single CEP-41 stream while preserving independent per-group cursor semantics. This enables clients tracking many groups to avoid opening separate tool calls per group, improving efficiency for large-scale group management.

The implementation includes:
- New `subscribeManyGroupMessages` method in the coordinator client and server adapter
- Input/output schemas supporting an array of group subscriptions with independent cursors
- Backlog replay and live streaming for each group with proper cursor tracking
- Proper cleanup of all child subscriptions on abort
- Unit tests verifying independent cursor behavior and subscription cleanup