import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))
);
const target = "public/pdfjs";
await mkdir(target, { recursive: true });
for (const name of ["cmaps", "standard_fonts", "wasm", "LICENSE"])
  await cp(join(source, name), join(target, name), { recursive: true });
