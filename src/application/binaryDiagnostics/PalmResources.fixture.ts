import type { PalmResources } from "../../domain/native/palmResources.js";

/** Parsed port response with a gap, appInfo, sortInfo and one resource. */
export const palmResourcesReportFixture = (): PalmResources => {
  const sha256 = "a".repeat(64);
  return {
    artifact: { path: "/fixtures/example.prc", bytes: 100, sha256 },
    format: "palm-resource-database",
    header: {
      location: { offset: 0, bytes: 78 },
      name: { value: "Fixture", raw_hex: "46697874757265".padEnd(64, "0") },
      attributes: 1,
      database_version: 1,
      created_raw: 0,
      modified_raw: 0,
      backup_raw: 0,
      modification_number: 0,
      app_info_offset: 90,
      sort_info_offset: 92,
      database_type: { value: "appl", raw_hex: "6170706c" },
      creator: { value: "Test", raw_hex: "54657374" },
      unique_id_seed: 0,
      next_record_list_offset: 0,
      resource_count: 1,
    },
    directory_location: { offset: 78, bytes: 10 },
    directory_gap: { location: { offset: 88, bytes: 2 }, sha256 },
    app_info: { location: { offset: 90, bytes: 2 }, sha256 },
    sort_info: { location: { offset: 92, bytes: 2 }, sha256 },
    resources: [
      {
        index: 0,
        type: { value: "code", raw_hex: "636f6465" },
        id: 1,
        entry_location: { offset: 78, bytes: 10 },
        payload: { location: { offset: 94, bytes: 6 }, sha256 },
        classification: "code-tagged",
        text: null,
      },
    ],
    coverage: { status: "complete", examined_entries: 1, resources: 1 },
    limitations: ["Synthetic port-response fixture."],
  };
};
