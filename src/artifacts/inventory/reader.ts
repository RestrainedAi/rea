import type { ArtifactReader } from "../ArtifactReader.js";
import { createArtifactReader } from "../ArtifactReaderFactory.js";
import { PeInstallerArtifactReader } from "../PeInstallerArtifactReader.js";
import { StaticArchiveArtifactReader } from "../staticArchive/StaticArchiveArtifactReader.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import {
  isZipPackageFormat,
  ZIP_NON_ENTRY_TAIL_LIMITATION,
} from "../../domain/zipPackageFormat.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";

export const createReader = (
  path: string,
  format: ArtifactOccurrence["artifact_format"],
  environment: Readonly<NodeJS.ProcessEnv>,
  rootSource?: StableRegularFileDescriptor,
  expectedRootSha256?: string,
): ArtifactReader | undefined =>
  createArtifactReader(path, format, environment, {
    purpose: "inventory",
    ...(rootSource === undefined ? {} : { rootSource }),
    ...(expectedRootSha256 === undefined ? {} : { expectedRootSha256 }),
  });

export const inventoryLimitations = (
  format: ArtifactOccurrence["artifact_format"],
  reader: ArtifactReader | undefined,
): string[] => {
  if (
    reader instanceof PeInstallerArtifactReader ||
    reader instanceof StaticArchiveArtifactReader
  )
    return [...reader.limitations];
  if (reader !== undefined)
    return isZipPackageFormat(reader.format)
      ? [ZIP_NON_ENTRY_TAIL_LIMITATION]
      : [];
  // dmg and pkg reach here only after classifyRootFormat matched their bytes.
  if (format === "dmg" || format === "pkg")
    return [
      `${format.toUpperCase()} root hash is observed; child inventory requires a native macOS adapter.`,
    ];
  if (format === "mach-o-universal" && process.platform !== "darwin")
    return ["Universal Mach-O slices require the native macOS lipo adapter."];
  return ["Artifact has no child container entries."];
};
