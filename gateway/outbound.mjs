/* global Buffer, Headers, Request, Response, URL */

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export class OutboundRequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first !== 0
    && first !== 10
    && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 0)
    && !(first === 192 && second === 168)
    && !(first === 198 && (second === 18 || second === 19))
    && !(first === 198 && second === 51 && octets[2] === 100)
    && !(first === 203 && second === 0 && octets[2] === 113)
    && first < 224;
}

function isSyntheticProxyIpv4(address) {
  const octets = address.split('.').map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 198
    && (octets[1] === 18 || octets[1] === 19);
}

function ipv6Words(address) {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const words = [...head, ...tail].map((part) => Number.parseInt(part, 16));
  const missing = 8 - words.length;
  if (halves.length === 1) return missing === 0 ? words : null;
  if (missing < 1) return null;
  return [
    ...head.map((part) => Number.parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...tail.map((part) => Number.parseInt(part, 16)),
  ];
}

function isPublicIpv6(address) {
  const words = ipv6Words(address);
  if (!words) return false;
  const [first, second] = words;
  return (first & 0xe000) === 0x2000
    && !(first === 0x2001 && (second === 0 || second === 0x0db8))
    && first !== 0x2002;
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  return isPublicIpv6(address);
}

function configuredOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function byteLimit(maxResponseBytes) {
  let length = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      length += chunk.length;
      callback(length > maxResponseBytes
        ? new OutboundRequestError('outbound_response_too_large')
        : null, chunk);
    },
  });
}

function decompressor(contentEncoding) {
  if (!contentEncoding || contentEncoding === 'identity') return null;
  if (contentEncoding === 'gzip') return createGunzip();
  if (contentEncoding === 'br') return createBrotliDecompress();
  if (contentEncoding === 'deflate') return createInflate();
  throw new OutboundRequestError('outbound_content_encoding_not_allowed');
}

function responseBodyStream(response, maxResponseBytes) {
  const declaredLength = Number(response.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    response.resume();
    throw new OutboundRequestError('outbound_response_too_large');
  }
  const encodings = String(response.headers['content-encoding'] ?? 'identity')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (encodings.length !== 1) {
    response.resume();
    throw new OutboundRequestError('outbound_content_encoding_not_allowed');
  }
  const pipe = (source, destination) => {
    source.once('error', (error) => destination.destroy(error));
    return source.pipe(destination);
  };
  let body = pipe(response, byteLimit(maxResponseBytes));
  const decoded = decompressor(encodings[0]);
  if (decoded) body = pipe(body, decoded);
  body = pipe(body, byteLimit(maxResponseBytes));
  body.once('error', () => response.destroy());
  body.once('close', () => {
    if (!response.complete) response.destroy();
  });
  return body;
}

async function readResponse(response, maxResponseBytes) {
  const body = responseBodyStream(response, maxResponseBytes);
  const chunks = [];
  try {
    for await (const chunk of body) chunks.push(chunk);
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    throw new OutboundRequestError('outbound_transport_unavailable');
  }
  return Buffer.concat(chunks);
}

async function serializeRequestBody(url, method, headers, body, maxRequestBytes) {
  try {
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const bytes = body === undefined ? undefined : Buffer.from(await request.arrayBuffer());
    if (bytes && bytes.length > maxRequestBytes) {
      throw new OutboundRequestError('outbound_request_too_large');
    }
    const requestHeaders = Object.fromEntries(request.headers.entries());
    if (bytes) requestHeaders['content-length'] = String(bytes.length);
    return { bytes, requestHeaders };
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    throw new OutboundRequestError('outbound_request_not_allowed');
  }
}

async function requestPinned(url, hostname, address, family, {
  method = 'GET',
  headers = {},
  body,
  maxRequestBytes = 1024 * 1024,
  maxResponseBytes,
  streamResponse = false,
}) {
  const { bytes: requestBody, requestHeaders } = await serializeRequestBody(
    url,
    method,
    headers,
    body,
    maxRequestBytes,
  );
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const outbound = request({
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      lookup: (_host, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        reject(new OutboundRequestError('outbound_redirect_not_allowed'));
        return;
      }
      if (streamResponse) {
        try {
          const body = responseBodyStream(response, maxResponseBytes);
          const headers = new Headers(response.headers);
          headers.delete('content-encoding');
          headers.delete('content-length');
          resolve(new Response(Readable.toWeb(body), {
            status: response.statusCode ?? 502,
            headers,
          }));
        } catch (error) {
          reject(error instanceof OutboundRequestError
            ? error
            : new OutboundRequestError('outbound_transport_unavailable'));
        }
        return;
      }
      void readResponse(response, maxResponseBytes)
        .then((body) => {
          const headers = new Headers(response.headers);
          headers.delete('content-encoding');
          headers.set('content-length', String(body.length));
          resolve(new Response(body, {
            status: response.statusCode ?? 502,
            headers,
          }));
        })
        .catch((error) => reject(error instanceof OutboundRequestError
          ? error
          : new OutboundRequestError('outbound_transport_unavailable')));
    });
    outbound.once('error', () => reject(new OutboundRequestError('outbound_transport_unavailable')));
    outbound.end(requestBody);
  });
}

export function createOutboundClient({
  resolveHost = (host) => lookup(host, { all: true, verbatim: true }),
  trustedPrivateOrigins = [],
  trustedHttpsSyntheticOrigins = [],
  requestTransport = requestPinned,
} = {}) {
  const trustedOrigins = new Set(trustedPrivateOrigins.map(configuredOrigin).filter(Boolean));
  const trustedSyntheticOrigins = new Set(
    trustedHttpsSyntheticOrigins
      .map(configuredOrigin)
      .filter((origin) => origin?.startsWith('https:')),
  );
  return {
    async fetch(target, options = {}) {
      const { allowedOrigin, maxResponseBytes = 1024 * 1024 } = options;
      let url;
      try {
        url = new URL(target);
      } catch {
        throw new OutboundRequestError('outbound_url_not_allowed');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || url.origin !== configuredOrigin(allowedOrigin)) {
        throw new OutboundRequestError('outbound_url_not_allowed');
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(hostname);
      const addresses = family
        ? [{ address: hostname, family }]
        : await resolveHost(hostname);
      if (!Array.isArray(addresses) || addresses.length === 0 || (
        !trustedOrigins.has(url.origin) && addresses.some(({ address }) => (
          !isPublicAddress(address)
          && !(trustedSyntheticOrigins.has(url.origin) && isSyntheticProxyIpv4(address))
        ))
      )) {
        throw new OutboundRequestError('outbound_address_not_allowed');
      }
      const address = addresses[0];
      return await requestTransport(url, hostname, address.address, address.family, {
        ...options,
        maxResponseBytes,
      });
    },
  };
}
