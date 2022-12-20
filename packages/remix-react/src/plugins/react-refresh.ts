import { createUnplugin } from 'unplugin';
import fse from 'fs-extra';
import { fileURLToPath } from "node:url";

// Vite is using an old version of react-refresh that doesn't include a fix we need.
// This plugin loads a patched version with the below fix.
// https://github.com/facebook/react/pull/22740
// TODO: Raise PR against https://github.com/vitejs/vite-plugin-react-swc/ so that we can remove this.

export const ReactRefresh = createUnplugin(function () {
  const runtimePublicPath = "/@react-refresh";
  return {
    name: 'remix:react-refresh',
    resolveId: (id) => (id === runtimePublicPath ? id : undefined),
    loadInclude(id: string) {
      return id === runtimePublicPath;
    },
    load() {
      const filePath = fileURLToPath(new URL("react-refresh-runtime.mjs", import.meta.url));
      return {
        code: fse.readFileSync(filePath, "utf-8"),
      };
    },
  };
});