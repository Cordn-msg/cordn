---
"@cordn/core": patch
---

fix(core): declare @noble deps, ship compiled dist, add MIT license

Fixes a consumer crash: ts-mls imports @noble/hashes (sha2/hmac) and
@noble/ciphers (aes) at runtime but declares them only as devDep/peer,
so installs of @cordn/core got neither. Declare both as direct deps
(pinned to ts-mls's 2.2.0 contract).

Package hardening for the public release:
- build ESM .js + .d.ts to dist/ via tsc; repoint main/types/exports
  so plain-Node/JS consumers work without a TS toolchain
- sideEffects: false (source verified pure) -> tree-shakeable
- files: ["dist"] -> no test files or source in the tarball
- exports map, engines (>=20.12), description, repository/bugs/keywords
- MIT license + LICENSE file + README