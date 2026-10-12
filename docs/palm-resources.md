# Palm resource inspection and export

`inspect_palm_resources` and `rea inspect-palm-resources PATH --json` inspect a
Palm application/resource database without executing it. The reader is original
TypeScript code, needs no additional dependency, and works on supported Node
hosts including Windows. It does not open an active binary target.

`extract_palm_resources` and `rea extract-palm-resources PATH --output NEW_DIRECTORY --json`
export every indexed resource to a raw `.bin` file plus `manifest.json`. The
destination must be absent and its parent must exist. REA never replaces an
existing output directory. Both operations use the same parser and stable input
snapshot. Export verifies each payload's length and SHA-256 while writing and
on readback; cancellation removes only the uncommitted operation-owned tree,
and failed cleanup retains the owner for retry and reports the affected path.

Names encode the resource index, type bytes as hex, and decimal ID, for example
`resources/00000-636f6465-00001.bin`. The manifest maps each file to its original
FourCC, ID, byte range and digest. Database names and raw type characters never
become output paths. Optional appInfo/sortInfo and padding are inventoried in
the manifest; only indexed resource payloads are exported. Empty resources and
the final resource through EOF are retained.

## Supported profile

The file header's resource-database bit selects the ten-byte resource directory.
A `.prc` filename alone is insufficient: PalmDOC/Mobipocket ebooks are record
databases and use a different directory and payload format. They receive a
specific unsupported-profile error from this resource reader.

The complete single-list result contains the 78-byte big-endian header, raw Palm
date values, byte-preserved name/type/creator fields, every resource type/ID and
its directory location, payload range and SHA-256. It retains optional appInfo
and sortInfo blocks and variable directory padding separately. The final
resource is included through EOF.

Resource offsets must increase strictly. Duplicate type/ID keys, chained lists,
truncated directories, out-of-file or overlapping metadata offsets, and exceeded
file, entry or metadata budgets fail without partial success. The result is
limited to 8 MiB of complete serialized metadata; file and resource-entry budgets
are caller-selectable through `max_file_bytes` and `max_entries`.

`code` and `data` labels report resource tags. They do not establish the processor
architecture or mean that every byte is an instruction: code 0 can contain
tables. `tAIN` and `tver` provide byte-preserving Latin-1 text through the first
NUL. Other resources, forms and bitmaps remain opaque. This is not decompilation,
original-source recovery, an ebook converter, or a Palm emulator. `open_binary`
does not yet admit PRC for deep-provider analysis.

## Format sources and existing tools

- [Palm File Format Specification](https://jichu4n.github.io/palm-pdb/assets/Palm%20File%20Format%20Specification.pdf), original Palm documentation: resource-header offsets, variable directory padding, optional block lengths, last-resource EOF, and recommended rejection of chained lists.
- [Historical PRC format notes by Theodore Ts'o](https://web.mit.edu/tytso/www/pilot/prc-format.html).
- [PRC-Tools release history](https://prc-tools.sourceforge.net/releases.html): 2.2 adds read-only PRC resource listing and code-resource disassembly in Palm-targeted objdump; 2.3 adds trap-name decoding. These are assembly utilities, not C decompilers.
- [Reko Palm loader](https://github.com/uxmal/reko/blob/master/src/Environments/PalmOS/PRC/PrcLoader.cs): a separate decompiler route with its own coverage and license; no Reko code is copied into this parser.
- [CloudpilotEmu](https://github.com/cloudpilot-emu/cloudpilot-emu): optional runtime emulation requires a compatible ROM and separate execution authorization.

The reader uses the original container specification, not code copied from the
referenced projects. Real-provider or emulator claims require separate tests.
