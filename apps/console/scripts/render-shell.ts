import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "vite-plus";

export const renderFirstScreen = async (root: string, clientOutDir: string): Promise<void> => {
  const page = join(clientOutDir, "index.html");
  const serverOut = join(root, "node_modules/.render-shell");

  await build({
    root,
    mode: "prerender",
    logLevel: "warn",
    build: {
      ssr: "src/entry.server.ts",
      outDir: serverOut,
      emptyOutDir: true,
      copyPublicDir: false,
    },
  });

  const { renderShell } = await import(pathToFileURL(join(serverOut, "entry.server.js")).href);

  await writeFile(page, await renderShell(await readFile(page, "utf8")));
};
