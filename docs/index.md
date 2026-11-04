---
owner: unassigned
proposed_owner: REA documentation maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6; guide semantics not revalidated
last_verified: never
verified_by: none
verification_scope: metadata adoption only; semantic review pending
layout: home

hero:
  name: REA
  text: Reverse Engineer Anything
  tagline: Understand binaries, applications, and runtime behavior with one CLI and MCP server.
  actions:
    - theme: brand
      text: Get started
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/morluto/rea

features:
  - title: Investigate with your agent
    details: Connect REA to your coding agent, describe the app or feature you want to understand, and follow the evidence.
    link: /mcp-prompts
  - title: Inspect across formats
    details: Explore native binaries, JavaScript and Electron apps, .NET assemblies, Android packages, firmware, and websites.
    link: /installation
  - title: Keep the evidence
    details: Analysis runs locally and returns observations, limitations, and unknowns through the CLI and MCP.
    link: /mcp-contracts
---

For this maintained fork, start with the [project documentation map](./README.md)
for current scope, Windows workbench status and safe development checks. The
upstream package examples below describe the inherited distribution.

## Start with one command

```bash
npx rea-agents setup
```

Choose your agent, review the planned changes, and approve setup. Native binary
analysis can use an existing Hopper, Ghidra, or IDA installation; static
JavaScript analysis needs no native analysis engine.

For a first result from an extracted JavaScript application or ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

See [installation and setup](./installation.md) for requirements and configuration.

![REA inspecting a native binary in Hopper](./assets/rea-hopper-analysis.png)
