import {
  inspectRecordedCrashInputSchema,
  recordedCrashSchema,
} from "../../domain/native/recordedCrash.js";
import {
  inspectBinaryLayoutInputSchema,
  binaryLayoutSchema,
} from "../../domain/native/binaryLayout.js";
import { binaryLayoutSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
} from "../../domain/native/peResources.js";
import {
  inspectPalmResourcesInputSchema,
  palmResourcesSchema,
  extractPalmResourcesInputSchema,
  palmExtractionSchema,
} from "../../domain/native/palmResources.js";

/** Caller-selected delivery of completed binary layout Evidence. */
export const inspectBinaryLayoutRequestSchema =
  inspectBinaryLayoutInputSchema.extend({ detail: analysisDetailSchema });

/** Offline binary diagnostics are independent of macOS process/UI providers. */
export const BINARY_DIAGNOSTICS_TOOL_CONTRACTS = [
  {
    name: "extract_palm_resources",
    ...toolContractMetadata("extract_palm_resources"),
    kind: "native-provider",
    description:
      "Export every indexed Palm OS PRC resource as unchanged raw .bin bytes, with the complete resource inventory and manifest.json. Uses one stable bounded input snapshot and the same validated resource map as inspect_palm_resources. Requires an absolute absent output_root with an existing parent; never replaces existing files or modifies the input. Filenames encode resource index, raw type hex and ID; payload SHA-256 and length are checked while writing and on readback. Malformed input or exhausted budgets publishes no successful export, and cancellation rolls back only the operation-owned tree. Reports any cleanup uncertainty. Raw resource export does not decompress bitmap data, reconstruct UI/source code, disassemble, or execute the application. Portable; no legacy tool, analysis engine, or Palm ROM required.",
    inputSchema: extractPalmResourcesInputSchema,
    outputSchema: evidenceResultOf(palmExtractionSchema),
    examples: [
      {
        title: "Export raw Palm resource blocks",
        input: {
          path: "/artifacts/application.prc",
          output_root: "/artifacts/resource-export",
        },
      },
    ],
  },
  {
    name: "inspect_palm_resources",
    ...toolContractMetadata("inspect_palm_resources"),
    kind: "native-provider",
    description:
      "Inspect an explicit local Palm OS application/resource database without executing it, opening an emulator, or starting a disassembler. Classifies by resource-database header, not .prc suffix; record databases, including PalmDOC/Mobipocket ebooks, require a separate reader. Returns the complete bounded single-list header and resource directory, byte-preserved four-character type/creator IDs, original file ranges, SHA-256 hashes, directory padding and optional appInfo/sortInfo blocks. Includes code/data resource tags and byte-preserving tAIN/tver text. Code tags do not establish CPU architecture, instructions, entry points or decompilation; form/bitmap payloads remain opaque. Chained lists, ambiguous offsets, duplicate type/IDs, malformed input and exhausted budgets return no partial success. Portable on supported Node hosts with no engine or Palm ROM required.",
    inputSchema: inspectPalmResourcesInputSchema,
    outputSchema: evidenceResultOf(palmResourcesSchema),
    examples: [
      {
        title: "Inspect Palm PRC resource identities and file bytes",
        input: { path: "/artifacts/application.prc" },
      },
    ],
  },
  {
    name: "inspect_pe_resources",
    ...toolContractMetadata("inspect_pe_resources"),
    kind: "native-provider",
    description:
      "Inspect one explicit local PE32/PE32+ image's complete bounded type/name/language resource tree without executing it or opening a disassembler. Returns numeric IDs versus original UTF-16 names, directory/data-entry file locations, payload RVA/file ranges, complete SHA-256 hashes and static RT_GROUP_ICON image-resource candidates. Language fallback, image decoding and actual shell/window loading remain unobserved. Reads a stable regular file; malformed or ambiguous mappings, non-identical overlapping ranges and exhausted budgets return no partial success. Portable on supported Node hosts; no Windows SDK or engine installation required.",
    inputSchema: inspectPeResourcesInputSchema,
    outputSchema: evidenceResultOf(peResourcesSchema),
    examples: [
      {
        title: "Inspect PE resource identities and icon relationships",
        input: { path: "/artifacts/application.exe" },
      },
    ],
  },
  {
    name: "inspect_binary_layout",
    ...toolContractMetadata("inspect_binary_layout"),
    kind: "native-provider",
    description:
      "Inspect an explicit local binary without launching it as a host process. Returns file-backed section/segment ranges, linked addresses, original symbol/REL/RELA table identities, complete encoded RELR tables and upstream-derived offsets with unknown per-word locations/addends, raw name bytes, dependency/interpreter names and static mitigation inferences inline with artifact SHA-256 Evidence. Initial profile: ELF64 x86-64 little-endian EXEC/DYN/REL on Linux x64 via caller-supplied Python with unchanged pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2. Runtime addresses/library paths, overall relocation inventory completeness and complete derived GOT/PLT coverage remain unknown. Zero executable entry values mean absence; relocatable entries are not applicable. Upstream can emulate PLT instructions with Unicorn for derived static maps. Uses bounded complete output and owned temporary files/processes; malformed, unsupported or oversized objects return no partial success. Select detail summary to retain the complete layout Evidence in this session and receive only its summary view, then inspect sections, symbols, mitigations or linkage with inspect_analysis_view.",
    inputSchema: inspectBinaryLayoutRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      binaryLayoutSchema,
      binaryLayoutSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect ELF linked and file layout",
        input: { path: "/artifacts/application.elf" },
      },
      {
        title: "Retain the complete layout and return its summary view",
        input: { path: "/artifacts/application.elf", detail: "summary" },
      },
    ],
  },
  {
    name: "inspect_recorded_crash",
    ...toolContractMetadata("inspect_recorded_crash"),
    kind: "native-provider",
    description:
      "Inspect a supplied Linux ELF64 amd64 little-endian core without launching its target or attaching to any live PID. Returns all recorded segments, raw note owners/descriptors and source ranges, every Linux CORE PRSTATUS thread/register and SIGINFO fields inline with SHA-256 Evidence. Historical PID is recorded metadata; current process/file identity, note coverage and signal-thread associations stay unknown. Optionally add derived core-only GDB/pwndbg mapping candidates through explicit BYO configuration; zero map flags mean unknown permissions. Uses the same stable snapshot for both stages, bounded complete output and owned cleanup. Initial Linux x64 profile: unchanged pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2; optional unchanged pwndbg 2026.09.15. No implicit executable/library pairing, GDB command language, host configuration changes or dependency installation.",
    inputSchema: inspectRecordedCrashInputSchema,
    outputSchema: evidenceResultOf(recordedCrashSchema),
    examples: [
      {
        title: "Inspect recorded registers and signal evidence",
        input: { path: "/artifacts/crash.core" },
      },
      {
        title: "Add core-only debugger mapping candidates",
        input: {
          path: "/artifacts/crash.core",
          include_debugger_context: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
