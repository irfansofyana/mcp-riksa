import { lookup as nodeLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

const BLOCKED_NAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
]);

function isBlockedAddress(address: string): boolean {
  if (address === '169.254.169.254' || address === '100.100.100.200') return true;
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    return normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts[0] === 169 && parts[1] === 254;
}

export function createSafeLookup(delegate: LookupFunction = nodeLookup): LookupFunction {
  return (hostname, options, callback) => delegate(hostname, options, (error, result, family) => {
    if (error) return callback(error, result, family);
    const addresses = typeof result === 'string' ? [result] : result.map((entry) => entry.address);
    if (addresses.some(isBlockedAddress)) {
      return callback(new Error(`Endpoint ${hostname} resolved to a blocked link-local address`), result, family);
    }
    callback(null, result, family);
  });
}

export async function validateHttpEndpoint(input: string, allowUnsafe = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('MCP endpoint must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP endpoint protocol must be http or https');
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in MCP endpoint URLs');
  if (allowUnsafe) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_NAMES.has(hostname) || hostname === 'metadata') {
    throw new Error('Cloud metadata endpoints are blocked');
  }
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('Link-local and cloud metadata endpoints are blocked');
    return url;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return url;

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new Error('Endpoint resolves to a blocked link-local address');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('blocked')) throw error;
  }
  return url;
}
