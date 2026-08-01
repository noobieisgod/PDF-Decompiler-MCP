# Pre-3.0 Migration Inventory

The migration began from Git commit `db8e01a4ee5a9690ae6a31f0522dda9967fae0fd`. A local archival branch named `archive/pdf-decompiler-pre-3.0.0-20260801` points to that commit. Existing tags `Release`, `Release_V1.1`, `Release_V1.2`, and `Release_V2.0` remain unchanged.

The starting repository contained README and license files, three tracked test PDFs, one calculation PDF, and three release or extracted ZIP archives. The desktop workspace separately contained primary and experimental source trees plus release ZIP versions. Those desktop directories were not deleted or modified. The experimental source was promoted into the cloned repository without copying `node_modules`, MCPB outputs, README, or license files.

Normalization removes the tracked PDFs and ZIP archives after synthetic fixture generation and package tests establish their replacement or obsolescence. It also removes the legacy entry shim, old one-call tool module, unused legacy fetch and response assemblers, temporary debug and export scripts, and stale product-specific paths. Historical names remain only in this inventory, `MIGRATION.md`, and `CHANGELOG.md`.

Git history is not rewritten. No legacy tag is deleted or moved. No force-push or remote push is part of this migration.
