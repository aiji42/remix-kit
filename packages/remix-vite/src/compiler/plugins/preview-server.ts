import type { Remix } from '@remix-kit/schema';
import { createRequestHandler } from '@remix-run/server-runtime';
import { createServerAdapter } from '@whatwg-node/server';
import type { Plugin } from 'vite';

export function previewServer(remix: Remix): Plugin {
  const build = require(remix.options.serverBuildPath);
  const requestHandler = createRequestHandler(build, 'production');
  const nodeServerAdapter = createServerAdapter(requestHandler);
  return {
    name: 'remix:preview-server',
    configurePreviewServer(server) {
      return () => {
        // We use @whatwg-node/server to translate the node http.IncomingMessage
        // request to a server agnostic Fetch Request that Remix understands.
        server.middlewares.use(nodeServerAdapter);
      };
    },
  };
}
