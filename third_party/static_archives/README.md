# Optional static archive analyzer notices

REA's optional Inno 7 and 7z backend is maintained in [our Binary Refinery fork](https://github.com/RestrainedAi/rea-binary-refinery), based on version 0.11.2. REA invokes its strict bridge through a pinned installation manifest. The runtime is an optional application-local dependency; REA's npm package does not automatically download it or execute supplied installer/archive members.

The deployment retains these notices:

- Binary Refinery: Jesko Hüttenhain's BSD-3-Clause notice in `Binary-Refinery-BSD-3-Clause.md`; our strict bridge additions retain those terms.
- CPython 3.14.10: complete included interpreter/component notices in `CPython-3.14.10-LICENSE.txt`.
- pure-magic-rs 0.5.1: package metadata declares `GPL-3.0 OR BSD-2-Clause`; this deployment selects BSD-2-Clause and preserves Quentin JEROME's notice in `pure-magic-rs-BSD-2-Clause.txt`. The notice was captured from the project's primary `LICENSE-BSD`; its URL and SHA-256 are retained in the local deployment receipt.

The installation manifest pins interpreter binaries, standard library, extension dependencies, our parser source and wrapper by byte count and SHA-256. Windows immutable file leases protect those admitted files during analysis. A fresh private bytecode-cache prefix prevents reading stale bytecode caches from the source checkout; bytecode writes are disabled. Source snapshots and process memory/deadline limits are owned by REA.

See [the static archive guide](../../docs/static-archives.md) for profiles, refusals, budgets and coordinate semantics. Proprietary applications, firmware, drivers and private investigation reports are excluded from source and distributions.
