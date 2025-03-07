import { type Chain, type Client, type Transport } from "viem";
import { rpc } from "viem/utils";

import type { Config } from "@/config/config.js";
import type { Common } from "@/Ponder.js";
import { chains } from "@/utils/chains.js";

type Request = (
  options: Parameters<typeof rpc.webSocketAsync>[1] &
    Parameters<typeof rpc.http>[1],
) => any;

export type Network = {
  name: string;
  chainId: number;
  request: Request;
  url: string;
  pollingInterval: number;
  defaultMaxBlockRange: number;
  maxHistoricalTaskConcurrency: number;
  finalityBlockCount: number;
};

export async function buildNetwork({
  networkName,
  network,
  common,
}: {
  networkName: string;
  network: Config["networks"][string];
  common: Common;
}) {
  const { chainId, transport } = network;

  const defaultChain =
    Object.values(chains).find((c) => ("id" in c ? c.id === chainId : false)) ??
    chains.mainnet;

  const chain = {
    ...defaultChain,
    name: networkName,
    id: chainId,
  };

  const rpcUrls = await getRpcUrlsForClient({ transport, chain });

  const request = await getRequestForTransport({ transport, chain });

  rpcUrls.forEach((rpcUrl) => {
    if (isRpcUrlPublic(rpcUrl)) {
      common.logger.warn({
        service: "config",
        msg: `Using public RPC URL for network "${networkName}". Ponder requires an RPC URL with a higher rate limit.`,
      });
    }
  });

  const resolvedNetwork: Network = {
    name: networkName,
    chainId: chainId,
    request,
    url: rpcUrls[0],
    pollingInterval: network.pollingInterval ?? 1_000,
    defaultMaxBlockRange: getDefaultMaxBlockRange({ chainId, rpcUrls }),
    maxHistoricalTaskConcurrency: network.maxHistoricalTaskConcurrency ?? 20,
    finalityBlockCount: getFinalityBlockCount({ chainId }),
  };

  return resolvedNetwork;
}

export function getDefaultMaxBlockRange({
  chainId,
  rpcUrls,
}: {
  chainId: number;
  rpcUrls: (string | undefined)[];
}) {
  let maxBlockRange: number;
  switch (chainId) {
    // Mainnet and mainnet testnets.
    case 1:
    case 3:
    case 4:
    case 5:
    case 42:
    case 11155111:
      maxBlockRange = 2_000;
      break;
    // Optimism.
    case 10:
    case 420:
      maxBlockRange = 50_000;
      break;
    // Polygon.
    case 137:
    case 80001:
      maxBlockRange = 50_000;
      break;
    // Arbitrum.
    case 42161:
    case 421613:
      maxBlockRange = 50_000;
      break;
    default:
      maxBlockRange = 50_000;
  }

  const isQuickNode = rpcUrls
    .filter((url): url is string => url !== undefined)
    .some((url) => url.includes("quiknode"));

  const isCloudflare = rpcUrls
    .filter((url): url is string => url !== undefined)
    .some((url) => url.includes("cloudflare-eth"));

  if (isQuickNode) {
    maxBlockRange = Math.min(maxBlockRange, 10_000);
  } else if (isCloudflare) {
    maxBlockRange = Math.min(maxBlockRange, 800);
  }

  return maxBlockRange;
}

/**
 * Returns the number of blocks that must pass before a block is considered final.
 * Note that a value of `0` indicates that blocks are considered final immediately.
 *
 * @param network The network to get the finality block count for.
 * @returns The finality block count.
 */
function getFinalityBlockCount({ chainId }: { chainId: number }) {
  let finalityBlockCount: number;
  switch (chainId) {
    // Mainnet and mainnet testnets.
    case 1:
    case 3:
    case 4:
    case 5:
    case 42:
    case 11155111:
      finalityBlockCount = 32;
      break;
    // Optimism.
    case 10:
    case 420:
      finalityBlockCount = 5;
      break;
    // Polygon.
    case 137:
    case 80001:
      finalityBlockCount = 100;
      break;
    // Arbitrum.
    case 42161:
    case 421613:
      finalityBlockCount = 40;
      break;
    // Zora.
    case 7777777:
      finalityBlockCount = 5;
      break;
    default:
      finalityBlockCount = 5;
  }

  return finalityBlockCount;
}

/**
 * Returns the list of RPC URLs backing a Transport.
 *
 * @param transport A viem Transport.
 * @returns Array of RPC URLs.
 */
export async function getRpcUrlsForClient(parameters: {
  transport: Transport;
  chain: Chain;
}) {
  // This is how viem converts a Transport into the Client.transport type.
  const { config, value } = parameters.transport({
    chain: parameters.chain,
    pollingInterval: 4_000, // default viem value
  });
  const transport = { ...config, ...value } as Client["transport"];

  async function getRpcUrlsForTransport(transport: Client["transport"]) {
    switch (transport.type) {
      case "http": {
        return [transport.url ?? parameters.chain.rpcUrls.default.http[0]];
      }
      case "webSocket": {
        try {
          const socket = await transport.getSocket();
          return [socket.url];
        } catch (e) {
          const symbol = Object.getOwnPropertySymbols(e).find(
            (symbol) => symbol.toString() === "Symbol(kTarget)",
          );
          if (!symbol) return [];
          const url = (e as any)[symbol]?._url;
          if (!url) return [];
          return [url.replace(/\/$/, "")];
        }
      }
      case "fallback": {
        // This is how viem converts a TransportConfig into the Client.transport type.
        const fallbackTransports = transport.transports.map((t: any) => ({
          ...t.config,
          ...t.value,
        })) as Client["transport"][];

        const urls: (string | undefined)[] = [];
        for (const fallbackTransport of fallbackTransports) {
          urls.push(...(await getRpcUrlsForTransport(fallbackTransport)));
        }

        return urls;
      }
      default: {
        // TODO: Consider logging a warning here. This will catch "custom" and unknown transports,
        // which we might not want to support.
        return [];
      }
    }
  }

  return getRpcUrlsForTransport(transport);
}

export async function getRequestForTransport(parameters: {
  transport: Transport;
  chain: Chain;
}): Promise<Request> {
  // This is how viem converts a Transport into the Client.transport type.
  const { config, value } = parameters.transport({
    chain: parameters.chain,
    pollingInterval: 4_000, // default viem value
  });
  const transport = { ...config, ...value } as Client["transport"];

  switch (transport.type) {
    case "http": {
      const url = transport.url ?? parameters.chain.rpcUrls.default.http[0];

      if (!url)
        throw Error(
          `Validation failed: Unable to find a http transport URL (network=${parameters.chain.name}). Commonly caused by unset env vars.`,
        );

      return (options) => rpc.http(url, options);
    }
    case "webSocket": {
      const socket = await transport.getSocket();

      if (!socket)
        throw Error(
          `Validation failed: Unable to find a websocket transport url (network=${parameters.chain.name}). Commonly caused by unset env vars.`,
        );

      return (options) => rpc.webSocketAsync(socket, options);
    }
    case "fallback": {
      return await getRequestForTransport({
        transport: () => transport.transports[0],
        chain: parameters.chain,
      });
    }
    default: {
      throw Error(
        `Validation failed: Unknown transport "${transport.type}" used. Please use "http", "websocket", or "fallback" (network=${parameters.chain.name})`,
      );
    }
  }
}

let publicRpcUrls: Set<string> | undefined = undefined;

/**
 * Returns `true` if the RPC URL is found in the list of public RPC URLs
 * included in viem/chains. Handles both HTTP and WebSocket RPC URLs.
 *
 * @param rpcUrl An RPC URL.
 * @returns Boolean indicating if the RPC URL is public.
 */
export function isRpcUrlPublic(rpcUrl: string | undefined) {
  if (rpcUrl === undefined) return true;

  if (!publicRpcUrls) {
    // By default, viem uses `chain.default.{http|webSocket}.[0]` if it exists.
    publicRpcUrls = Object.values(chains).reduce<Set<string>>((acc, chain) => {
      chain.rpcUrls.default.http.forEach((httpRpcUrl) => {
        acc.add(httpRpcUrl);
      });

      (
        (chain.rpcUrls.default as unknown as { webSocket?: string[] })
          .webSocket ?? []
      ).forEach((webSocketRpcUrl) => {
        acc.add(webSocketRpcUrl);
      });

      return acc;
    }, new Set<string>());
  }

  return publicRpcUrls.has(rpcUrl);
}
