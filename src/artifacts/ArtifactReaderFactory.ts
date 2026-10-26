import { AsarArtifactReader } from "./AsarArtifactReader.js";
import type { ArtifactReader } from "./ArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";
import { NativeDmgArtifactReader } from "./NativeDmgArtifactReader.js";
import { ZipArtifactReader } from "./ZipArtifactReader.js";
import { PeInstallerArtifactReader } from "./PeInstallerArtifactReader.js";
import { StaticArchiveArtifactReader } from "./staticArchive/StaticArchiveArtifactReader.js";
import type { ArtifactOccurrence } from "../domain/artifactGraph.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { isZipPackageFormat } from "../domain/zipPackageFormat.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/** Inventory and materialization share one archive profile and decoder selection. */
export const createArtifactReader = (
  path: string,
  format: ArtifactOccurrence["artifact_format"] | BinaryTarget["format"],
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    readonly purpose: "inventory" | "extraction";
    readonly rootSource?: StableRegularFileDescriptor;
    readonly expectedRootSha256?: string;
  },
): ArtifactReader | undefined => {
  if (isZipPackageFormat(format))
    return new ZipArtifactReader(path, format, undefined, options.rootSource);
  switch (format) {
    case "directory":
      return new DirectoryArtifactReader(path);
    case "asar":
      return new AsarArtifactReader(path);
    case "pe":
      return new PeInstallerArtifactReader(
        path,
        environment,
        options.rootSource,
        options.expectedRootSha256,
      );
    case "7z":
      return new StaticArchiveArtifactReader(
        path,
        environment,
        options.expectedRootSha256,
      );
    case "mach-o":
      return options.purpose === "extraction"
        ? new MachOSliceArtifactReader(path, environment)
        : undefined;
    case "mach-o-universal":
      return options.purpose === "extraction" || process.platform === "darwin"
        ? new MachOSliceArtifactReader(
            path,
            environment,
            undefined,
            options.rootSource,
          )
        : undefined;
    case "dmg":
      return options.purpose === "inventory" && process.platform === "darwin"
        ? new NativeDmgArtifactReader(path, environment)
        : undefined;
    default:
      return undefined;
  }
};

/** Run container admission before an extraction output root is created. */
export const prepareArtifactReader = async (
  reader: ArtifactReader,
  signal?: AbortSignal,
): Promise<boolean> =>
  reader instanceof PeInstallerArtifactReader ||
  reader instanceof StaticArchiveArtifactReader
    ? reader.prepare(signal)
    : true;
