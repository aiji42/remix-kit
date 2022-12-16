import { createApp, defineEventHandler, fromNodeMiddleware } from 'h3';
import * as http from 'http';
import { ViteNodeServer } from 'vite-node/server';
import { resolve as resolveModule } from 'mlly';
import type { ViteBuildContext } from './vite';
import { createIsExternal } from './utils/external';
import { Connect, ModuleNode, ViteDevServer } from 'vite';
import { logger } from '@remix-kit/kit';
import type { Application } from 'express';
import { VitePlugin } from 'unplugin';
import { resolve } from 'pathe';
import { ViteNodeRunner } from 'vite-node/client';
import { createRunner } from './runtime/dev-server';
import { createDevAssetsManifest } from './compiler/plugins/dev-server-manifest';

export declare interface RequestAdapterParams<App> {
  app: App;
  server: ViteDevServer;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  next: Connect.NextFunction;
}

export declare type RequestAdapter<App = any> = (
  params: RequestAdapterParams<App>
) => void | Promise<void>;

export const ExpressHandler: RequestAdapter<Application> = ({ app, req, res }) => {
  app(req, res);
};

// Store the invalidates for the next rendering
const invalidates = new Set<string>();

export function viteNodePlugin(ctx: ViteBuildContext): VitePlugin {
  function markInvalidate(mod: ModuleNode) {
    if (!mod.id) {
      return;
    }
    if (invalidates.has(mod.id)) {
      return;
    }
    invalidates.add(mod.id);
    for (const importer of mod.importers) {
      markInvalidate(importer);
    }
  }

  return {
    name: 'remix:vite-node-server',
    enforce: 'post',
    async configureServer(server) {
      // Invalidate server build when manifest rebuilt
      ctx.remix.hook('build:assetsManifest', () => {
        for (const [id, mod] of server.moduleGraph.idToModuleMap) {
          if (id.startsWith('@remix-run/dev/server-build')) {
            markInvalidate(mod);
          }
        }
      });
    },
    handleHotUpdate({ file, server }) {
      const mods = server.moduleGraph.getModulesByFile(file) || [];
      for (const mod of mods) {
        markInvalidate(mod);
      }
    },
  };
}

function createNodeServer(viteServer: ViteDevServer, ctx: ViteBuildContext) {
  const node: ViteNodeServer = new ViteNodeServer(viteServer, {
    deps: {
      inline: [/^#/, ...(ctx.remix.options.build.transpile as string[])],
    },
    transformMode: {
      web: [/entry.client.tsx/],
      ssr: [/.*/],
    },
  });
  const isExternal = createIsExternal(viteServer, ctx.remix.options.rootDir);
  node.shouldExternalize = async (id: string) => {
    let result = await isExternal(id);
    console.debug(result);
    if (id.includes('@remix-run')) {
      console.debug(`isExternal2: (${id})`);
      if (id.includes('@remix-run/dev/server-build')) return false;
      return id;
    }
    if (result?.external) {
      console.debug(`resolving: (${result.id})`);
      const module = await resolveModule(result.id, { url: ctx.remix.options.modulesDir });
      console.debug(`resolve: (${result.id}) ` + module);
      return id;
    }
    return false;
  };

  return node;
}

function createViteNodeApp(ctx: ViteBuildContext) {
  const app = createApp();

  app.use(
    '/build/manifest-dev.js',
    defineEventHandler(async (event) => {
      event.node.res.setHeader('Content-Type', 'application/javascript');
      const response = `window.__remixManifest=${JSON.stringify(ctx.remix._assetsManifest)};`;
      return response;
    })
  );

  return app;
}

export async function initViteNodeServer(ctx: ViteBuildContext) {
  const node = createNodeServer(ctx.ssrServer!, ctx);
  const nodeRunner = await createRunner(node, ctx.remix.options.srcDir, '/public/');

  const serverEntryPath = resolve(ctx.remix.options.rootDir, ctx.remix.options.serverEntryPoint!);
  const handler = createRemixHandler(ctx.ssrServer!, nodeRunner, serverEntryPath);

  const app = createViteNodeApp(ctx);
  ctx.clientServer?.middlewares.use(handler);
  app.use(fromNodeMiddleware(ctx.clientServer!.middlewares));

  ctx.remix.server = app;
}

function createRemixHandler(
  server: ViteDevServer,
  runner: ViteNodeRunner,
  serverEntryPath: string
) {
  let devServer;
  const requestHandler = ExpressHandler;
  return async (req, res, next) => {
    logger.info(`Document request (${req.url})`);
    const updates = runner.moduleCache.invalidateDepTree(invalidates);

    // Invalidate cache for files changed since last rendering
    invalidates.clear();

    // Execute SSR bundle on demand
    // https://antfu.me/posts/dev-ssr-on-nuxt#approach-3-vite-node
    const start = performance.now();
    devServer =
      !devServer || updates.size > 0
        ? (await runner.executeFile(serverEntryPath)).devServer
        : devServer;
    if (updates.size) {
      const time = Math.round((performance.now() - start) * 1000) / 1000;
      logger.success(`Vite server hmr ${updates.size} files`, time ? `in ${time}ms` : '');
    }

    if (!devServer) {
      logger.error(`Failed to find a named export 'devServer' from ${serverEntryPath}`);
      process.exit(1);
    }

    // some apps may be created with a function returning a promise
    devServer = await devServer;

    await requestHandler({ app: devServer, server, req, res, next });
  };
}