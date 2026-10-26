# Samsung TAR.MD5 inspection and export

REA provides a portable, original reader for plain GNU/POSIX TAR.MD5 firmware
packages. It inventories all supported members, hashes the complete source and
each payload, and compares the stored MD5 without starting a supplied program,
mounting an image or connecting to a device. It needs no Linux extractor.

```powershell
rea inspect-samsung-firmware 'D:\artifacts\firmware.tar.md5' --json
rea extract-samsung-firmware 'D:\artifacts\firmware.tar.md5' --output 'D:\artifacts\new-export' --json
```

The equivalent target-free MCP calls are `inspect_samsung_firmware` with
`{"path":"D:\\artifacts\\firmware.tar.md5"}` and `extract_samsung_firmware`
with that path plus `output_root`. No `open_binary` call is required. The output
directory must be absent and its parent must exist. Existing files are never
replaced. Extraction writes every regular member unchanged, the original
`__samsung_footer.bin` and `manifest.json`; directories carry no payload bytes.

## Correct checksum boundaries

A Samsung package can append build information after its TAR terminator and
before its final digest/filename record. The MD5 covers the prefix ending at
the start of that checksum record, including preceding build metadata. Hashing
only the TAR extent can therefore disagree with a valid stored checksum.

REA separately reports the TAR extent, two zero terminator blocks, extra zero
padding, complete raw footer, checksum-record range, and actual hashed range.
`original_tar_file_size`, when present, must match the TAR/footer boundary. The
checksum filename is retained as inert metadata and never selects a path.
Inspection reports `match` or `mismatch`; extraction requires `match` before
creating output. MD5 is an integrity comparison and does not authenticate the
publisher, certify firmware compatibility or establish account recovery.

This boundary was derived from static REA/Ghidra observations of supplied Odin
executables and an exported checksum entry point, then independently checked
against actual input bytes. No proprietary implementation is copied or bundled.

## Supported profile and provenance

The reader accepts regular files and zero-size directories in POSIX USTAR or
the plain GNU header profile. It preserves complete fixed-width name/prefix
fields, each original 512-byte header and its SHA-256, validated unsigned
header checksum, payload ranges/hashes and alignment padding ranges. GNU header
fields are not reinterpreted as a POSIX path prefix.

File layout follows the [GNU TAR format documentation](https://www.gnu.org/software/tar/manual/html_node/Standard.html).
Unsupported PAX, GNU long-name/link/sparse extensions, links and special files
are refused explicitly. Headers, two zero terminator blocks and all padding
must satisfy the narrow plain profile. Footer text is bounded ASCII with one
terminal MD5/filename record; raw bytes and original line endings are retained.

All locations describe original file bytes. Raw filesystem images, boot images
and bootloaders remain opaque. No device partition address, model compatibility,
unlock success, source recovery or application behavior is inferred.

## Limits and ownership

Reads use at most 1 MiB buffers. The default complete source I/O budget is 8 GiB,
selectable up to 64 GiB; the default header budget is 8,192, selectable up to
65,535. Complete serialized metadata has an 8 MiB budget checked before the
full byte pass and before export, and the original footer is limited to 64 KiB.
Exhausted limits return no partial successful inventory.

Inspection uses one admitted regular descriptor and verifies file identity and
metadata. Export verifies source-bound payload size/SHA-256 during writing and
on readback, then rehashes the complete source before publication. Shared output
ownership rejects traversal, platform escapes and replacement. Cancellation
rolls back only the operation-owned tree; unconfirmed descriptor/output cleanup
retains the exact owner for retry. Complete observations survive cleanup errors.

Verification covers original synthetic fixtures, malformed and unsupported
framing, metadata-inclusive checksum ranges, multi-gigabyte virtual offsets,
path safety, metadata/source limits, cancellation, source tamper, retained cleanup
ownership, and public compiled CLI/real stdio MCP parity.
