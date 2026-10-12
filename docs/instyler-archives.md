# Instyler installer inventory and extraction

REA's existing `inspect_artifact` and `extract_artifact` workflows support a
narrow, original reader for Instyler Ex-it! 1.6 PE installers whose overlay
starts with `IS011A0020`. The implementation parses archive packaging without
executing the installer or any contained file. It does not decompile the
installed application's logic or reconstruct its original source.

```powershell
rea inspect-artifact 'D:\path\installer.exe' --json
rea extract-artifact 'D:\path\installer.exe' --json
```

For MCP, call `open_binary` with the explicit installer path, then
`inspect_artifact` or `extract_artifact` with `{}`. Extraction chooses a new
temporary directory and returns its absolute location. The root keeps its PE
identity; each recovered member has its observed SHA-256 and decoded length.
No additional tool, external extractor, emulator or analysis engine is needed.

## Supported framing and provenance

The profile admits one directory after the six-byte signature, a fixed
`0x1b9a` configuration block, declared `0x30` attribute records and `0x11f`
file records. Supported file records have the observed plain zlib flags
`1/1/0`, a byte-preserving Latin-1 shortstring name, contiguous data-relative
offsets, and explicit decoded and encoded lengths. Each payload is prefixed
by `zlb\x1a`; the complete declared frames must terminate at EOF.

The parser preserves configuration, attributes, file records and the auxiliary
bytes preceding payload data as `__instyler_metadata.bin`. These bytes remain
opaque. This synthetic member has its real source range; each compressed member
instead records its encoded range and original name bytes in its limitations.
Decoded bytes have no direct physical source range. Windows separators normalize
once to safe logical archive paths, while variables such as `%appfolder%` stay
literal. No variable expansion, guessed installation behavior or runtime state
is implied.

The directory fields were derived from a read-only installer-wrapper routine.
The independent
[Detect It Easy Instyler signature](https://github.com/horsicq/Detect-It-Easy/blob/c9f58b9b8d1bd251c99e60565246092ff6920b1f/db_extra/PE/installer_instyler.1.sg)
corroborates the overlay prefix and Instyler 1.6/zlib identification; it does not
define the directory structure.
The reader is original code; no external unpacker source or binary is bundled.
Zlib framing and checksums follow [RFC 1950](https://www.rfc-editor.org/rfc/rfc1950).

## Refusals and limits

Recognized sources and their aggregate declared decoded members each have a
64 MiB budget. Complete directory and projected entry metadata each have an
8 MiB budget, checked before retaining more records. Streaming inflation checks
the actual output against the declared length, validates the complete checksum,
and rejects trailing compressed bytes. Bad offsets, overlaps, flags, duplicate
or unsafe paths, short frames and size mismatches fail explicitly. Cancellation,
source identity, retained descriptor cleanup and verified output rollback use
the shared artifact ownership rules.

Ordinary PE files keep their existing root-only inventory and refuse extraction.
Other Instyler versions, encrypted or alternative compressed profiles, nested
archive expansion, configuration decoding and application semantics are outside
this profile. Recovering every declared outer file does not establish complete
recovery of all nested resources, behavior or original source.

Verification includes original synthetic fixtures through the compiled CLI and
real stdio MCP server, checksum and expansion refusals, source preservation,
physical-range provenance, malformed framing, cancellation, retained close
ownership, path safety and ordinary PE behavior.
