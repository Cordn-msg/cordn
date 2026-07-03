# Application Specifications

This directory contains application-level specifications that build on top of the `cordn` core protocol.

## Core vs Application Specifications

The `cordn` specification is organized into two tiers:

### Core Specifications

Core specifications live in the parent [`spec/`](../) directory and are numbered sequentially (`00.md`, `01.md`, `02.md`, etc.).

Core specifications define:

- The fundamental coordinator protocol surface
- Identity models and KeyPackage publication semantics
- Message ordering and cursor-based fetch progression
- MLS extension formats and serialization
- Trust boundaries and validation requirements
- Interoperability primitives that all implementations MUST support

Core specifications are normative and define the minimal protocol surface required for interoperability. They are intentionally minimal and stable, evolving slowly through careful extension.

### Application Specifications

Application specifications live in [`spec/applications/`](.) and use readable names instead of numbers (e.g., `join-requests.md`).

Application specifications define:

- Higher-level features built using core protocol primitives
- Application-specific workflows and processing flows
- Feature-specific validation rules and edge case handling
- Client-side behavior and user experience patterns
- Optional functionality that implementations MAY support

Application specifications are normative for the features they describe, but they are optional extensions. An implementation can be fully compliant with the core protocol without implementing any application specifications.

## Rationale

This two-tier structure separates concerns:

1. **Stability**: Core specifications remain stable and minimal, reducing the risk of breaking changes to the fundamental protocol.

2. **Flexibility**: Application specifications can evolve more rapidly, allowing the ecosystem to experiment with new features without destabilizing the core.

3. **Clarity**: Implementers can clearly distinguish between "must implement for interoperability" (core) and "may implement for specific use cases" (application).

4. **Discoverability**: Numbered core specs provide a clear reading order for understanding the protocol foundation. Named application specs make it easy to find specific features.

5. **Scope control**: Core specs focus on protocol mechanics. Application specs focus on feature semantics and workflows.

## Naming Convention

Application specifications use lowercase kebab-case names that describe the feature

Avoid generic names like `features.md` or `extensions.md`. Each file should describe one cohesive feature or workflow.

## Structure and Tone

Application specifications follow the same structure and tone as core specifications:

- Status line at the top (`- Status: Draft` or `- Status: Stable`)
- Abstract section explaining the purpose and scope
- Specification section with numbered subsections
- Clear MUST/MAY/SHOULD language for requirements
- Rationale section explaining design decisions
- Cross-references to core specifications where relevant

However, application specifications may include:

- More detailed processing flows and workflows
- Client-side behavior and UX patterns
- Edge case handling and error recovery strategies
- Examples and use case descriptions

## When to Write an Application Specification

Write an application specification when:

- A feature requires coordination between multiple core protocol primitives
- Client-side behavior needs standardization for interoperability
- A workflow involves multiple steps that could be implemented inconsistently
- Edge cases need explicit handling to prevent divergent behavior

Do not write an application specification when:

- The feature is purely client-side with no protocol implications
- The behavior is already fully defined by core specifications
- The feature is implementation-specific and not intended for interoperability

## Current Application Specifications

- [`encrypted-media.md`](encrypted-media.md) — End-to-end encrypted media sharing via content-addressed storage and NIP-92 `imeta` references
- [`multi-device.md`](multi-device.md) — Out-of-band synchronization of per-group MLS state across devices of one identity via a sealed, content-addressed session document
- [`join-requests.md`](join-requests.md) — Coordinator-mediated join request signaling for shareable group links
- [`welcome-delivery.md`](welcome-delivery.md) — Coordinator-mediated Welcome delivery and the invitee membership-boundary cursor hint
