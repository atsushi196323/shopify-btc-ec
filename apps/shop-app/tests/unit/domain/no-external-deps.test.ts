import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR 3: src/domain/ は外部依存ゼロ（Prisma・Shopify・BTCPay の型も import しない）。domain の中の相対 import だけを許す
const domainDir = fileURLToPath(new URL("../../../src/domain/", import.meta.url));
const files = readdirSync(domainDir).filter((name) => name.endsWith(".ts"));

describe("domain の依存", () => {
  it.each(files)("%s は domain の中だけを import する", (name) => {
    const source = readFileSync(domainDir + name, "utf8");
    const specifiers = [...source.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);

    expect(specifiers.filter((specifier) => !specifier.startsWith("./"))).toEqual([]);
  });
});
