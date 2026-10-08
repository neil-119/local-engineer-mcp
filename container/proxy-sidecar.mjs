import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join, normalize } from 'node:path';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflate } from 'node:zlib';

export function relayTarget(requestPath, upstreamUrl) {
  const target = new URL(upstreamUrl);
  const incoming = new URL(requestPath, 'http://relay.invalid');
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = '';
  return target;
}

export class IncrementalSseParser {
  constructor(options = {}) {
    const { maxEventBytes = 8 * 1024 * 1024 } = options;
    this.maxEventBytes = maxEventBytes;
    this.decoder = new StringDecoder('utf8');
    this.charBuffer = '';
    this.currentLines = [];
    this.currentEventBytes = 0;
    this.scanOffset = 0;
  }

  feed(chunk) {
    const str = this.decoder.write(chunk);
    return this._processChars(str, false);
  }

  end() {
    const str = this.decoder.end();
    return this._processChars(str, true);
  }

  _processChars(str, isEnd) {
    this.charBuffer += str;
    const events = [];

    let i = this.scanOffset;
    let lineStart = 0;
    while (i < this.charBuffer.length) {
      const ch = this.charBuffer[i];
      if (ch === '\r') {
        if (i + 1 < this.charBuffer.length) {
          if (this.charBuffer[i + 1] === '\n') {
            const line = this.charBuffer.slice(lineStart, i);
            i += 2;
            lineStart = i;
            const event = this._handleLine(line);
            if (event) events.push(event);
          } else {
            const line = this.charBuffer.slice(lineStart, i);
            i += 1;
            lineStart = i;
            const event = this._handleLine(line);
            if (event) events.push(event);
          }
        } else {
          if (isEnd) {
            const line = this.charBuffer.slice(lineStart, i);
            i += 1;
            lineStart = i;
            const event = this._handleLine(line);
            if (event) events.push(event);
          } else {
            break;
          }
        }
      } else if (ch === '\n') {
        const line = this.charBuffer.slice(lineStart, i);
        i += 1;
        lineStart = i;
        const event = this._handleLine(line);
        if (event) events.push(event);
      } else {
        i++;
      }

      const unparsedLineChars = i - lineStart;
      if (
        this.currentEventBytes + unparsedLineChars > this.maxEventBytes ||
        (unparsedLineChars > 0 &&
          unparsedLineChars % 1024 === 0 &&
          this.currentEventBytes + Buffer.byteLength(this.charBuffer.slice(lineStart, i), 'utf8') >
            this.maxEventBytes)
      ) {
        const err = new Error('SSE_EVENT_BYTE_LIMIT_EXCEEDED');
        err.code = 'SSE_EVENT_TOO_LARGE';
        throw err;
      }
    }

    this.charBuffer = this.charBuffer.slice(lineStart);
    this.scanOffset = i - lineStart;

    if (
      this.currentEventBytes + Buffer.byteLength(this.charBuffer, 'utf8') >
      this.maxEventBytes
    ) {
      const err = new Error('SSE_EVENT_BYTE_LIMIT_EXCEEDED');
      err.code = 'SSE_EVENT_TOO_LARGE';
      throw err;
    }

    if (isEnd) {
      if (this.charBuffer.length > 0) {
        const line = this.charBuffer;
        this.charBuffer = '';
        this.scanOffset = 0;
        const event = this._handleLine(line);
        if (event) events.push(event);
      }
      if (this.currentLines.length > 0) {
        const event = this._dispatchCurrentEvent();
        if (event) events.push(event);
      }
    }

    return events;
  }

  _handleLine(line) {
    this.currentEventBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (this.currentEventBytes > this.maxEventBytes) {
      const err = new Error('SSE_EVENT_BYTE_LIMIT_EXCEEDED');
      err.code = 'SSE_EVENT_TOO_LARGE';
      throw err;
    }

    if (line === '') {
      return this._dispatchCurrentEvent();
    } else {
      this.currentLines.push(line);
      return null;
    }
  }

  _dispatchCurrentEvent() {
    if (this.currentLines.length === 0) {
      this.currentEventBytes = 0;
      return null;
    }
    const lines = this.currentLines;
    this.currentLines = [];
    this.currentEventBytes = 0;

    let eventType = null;
    let id = null;
    const dataLines = [];
    const otherLines = [];

    for (const line of lines) {
      if (line.startsWith(':')) {
        otherLines.push(line);
      } else if (line.startsWith('event:')) {
        let val = line.slice(6);
        if (val.startsWith(' ')) val = val.slice(1);
        eventType = val;
      } else if (line.startsWith('data:')) {
        let val = line.slice(5);
        if (val.startsWith(' ')) val = val.slice(1);
        dataLines.push(val);
      } else if (line.startsWith('id:')) {
        let val = line.slice(3);
        if (val.startsWith(' ')) val = val.slice(1);
        id = val;
      } else {
        otherLines.push(line);
      }
    }

    return {
      eventType,
      id,
      data: dataLines.length > 0 ? dataLines.join('\n') : null,
      otherLines,
      rawLines: lines,
    };
  }
}

export function serializeSseEvent(event) {
  const parts = [];
  if (event.eventType) parts.push(`event: ${event.eventType}`);
  if (event.id) parts.push(`id: ${event.id}`);
  if (Array.isArray(event.otherLines)) {
    for (const line of event.otherLines) {
      parts.push(line);
    }
  }
  if (event.data !== null && event.data !== undefined) {
    const lines = event.data.split('\n');
    for (const line of lines) {
      parts.push(`data: ${line}`);
    }
  }
  return parts.join('\n') + '\n\n';
}

export function transformParsedSseEvent(event, nameMapping) {
  if (!event || !event.data || nameMapping.size === 0) {
    return serializeSseEvent(event);
  }

  if (event.data === '[DONE]') {
    return serializeSseEvent(event);
  }

  let parsed;
  try {
    parsed = JSON.parse(event.data);
  } catch (err) {
    const parseErr = new Error(`Malformed SSE data JSON: ${err.message}`);
    parseErr.code = 'INVALID_SSE_JSON';
    throw parseErr;
  }

  unflattenResponseObject(parsed, nameMapping);
  event.data = JSON.stringify(parsed);
  return serializeSseEvent(event);
}

export function transformSseBlock(block, nameMapping) {
  if (!block || nameMapping.size === 0) return block;
  const parser = new IncrementalSseParser();
  const events = [...parser.feed(Buffer.from(block)), ...parser.end()];
  const serialized = events.map((ev) => transformParsedSseEvent(ev, nameMapping)).join('');
  return serialized.endsWith('\n\n') ? serialized.slice(0, -2) : serialized;
}

export const MAX_HISTORY_REGISTRY_ENTRIES = 256;

export function getGenuineMcpAlias(ns, trustedMcpServers = ['file_tools']) {
  if (typeof ns !== 'string') return null;
  const trusted = trustedMcpServers instanceof Set ? trustedMcpServers : new Set(trustedMcpServers);

  if (ns.startsWith('mcp__')) {
    const unaliased = ns.slice(5);
    if (trusted.has(unaliased)) {
      return unaliased;
    }
  } else {
    if (trusted.has(ns)) {
      const aliased = `mcp__${ns}`;
      if (aliased.length <= 40 && /^[a-zA-Z0-9_-]{1,40}$/.test(aliased) && !aliased.includes('__ns__')) {
        return aliased;
      }
    }
  }
  return null;
}

function resolveCurrentToolMapping(ns, fnName, currentRequestMapping, trustedMcpServers) {
  const directKey = `${ns}__ns__${fnName}`;
  const direct = currentRequestMapping.get(directKey);
  if (direct) {
    return { flattenedName: directKey, mapping: direct };
  }
  const aliasNs = getGenuineMcpAlias(ns, trustedMcpServers);
  if (aliasNs) {
    const aliasKey = `${aliasNs}__ns__${fnName}`;
    const alias = currentRequestMapping.get(aliasKey);
    if (alias) {
      return { flattenedName: aliasKey, mapping: alias };
    }
  }
  return null;
}

function resolveFlattenedToolName(fnName, currentRequestMapping, trustedMcpServers) {
  if (typeof fnName !== 'string') return null;
  if (!fnName.includes('__ns__')) return null;
  const parts = fnName.split('__ns__');
  if (parts.length !== 2) {
    return null;
  }
  const [nsPart, namePart] = parts;
  if (!nsPart || !namePart || !/^[a-zA-Z0-9_-]{1,40}$/.test(nsPart) || !/^[a-zA-Z0-9_-]+$/.test(namePart)) {
    return null;
  }
  const resolved = resolveCurrentToolMapping(nsPart, namePart, currentRequestMapping, trustedMcpServers);
  return resolved ? resolved.flattenedName : null;
}

export function flattenResponsesRequest(body, options = {}) {
  if (!body || typeof body !== 'object') return { nameMapping: new Map() };
  const { historyRegistry, trustedMcpServers = ['file_tools'] } = options;
  const trusted = trustedMcpServers instanceof Set ? trustedMcpServers : new Set(trustedMcpServers);

  // currentRequestMapping is strictly request-local: declared tools in this request
  const currentRequestMapping = new Map();

  // historyMapping starts with committed history from historyRegistry
  const historyMapping = new Map();
  if (historyRegistry && typeof historyRegistry.forEach === 'function') {
    historyRegistry.forEach((val, key) => {
      historyMapping.set(key, val);
    });
  }

  // Staged entries to commit to historyRegistry ONLY upon complete validation success
  const stagedHistoryEntries = new Map();

  const allToolNames = new Set();
  const allAliasNames = new Set();

  if (Array.isArray(body.input)) {
    const extractedTools = [];
    const remainingInput = [];
    for (const item of body.input) {
      if (item && typeof item === 'object' && item.type === 'additional_tools') {
        if (Array.isArray(item.tools)) {
          extractedTools.push(...item.tools);
        }
      } else {
        remainingInput.push(item);
      }
    }
    if (extractedTools.length > 0) {
      if (!Array.isArray(body.tools)) {
        body.tools = extractedTools;
      } else {
        body.tools = [...body.tools, ...extractedTools];
      }
      body.input = remainingInput;
    }
  }

  if ('tools' in body) {
    if (!Array.isArray(body.tools)) {
      const err = new Error('Field "tools" must be an array');
      err.code = 'MALFORMED_TOOLS_SPEC';
      throw err;
    }

    const flattenedTools = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') {
        const err = new Error('Each tool must be an object');
        err.code = 'MALFORMED_TOOL_SPEC';
        throw err;
      }

      if (tool.type === 'namespace') {
        if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(tool.name)) {
          const err = new Error(`Invalid namespace tool name: ${tool.name}`);
          err.code = 'INVALID_NAMESPACE_NAME';
          throw err;
        }
        if (tool.name.includes('__ns__')) {
          const err = new Error(`Namespace name contains reserved delimiter: ${tool.name}`);
          err.code = 'TOOL_COLLISION';
          throw err;
        }
        if (!Array.isArray(tool.tools) || tool.tools.length === 0) {
          const err = new Error(`Namespace tool "${tool.name}" must contain non-empty tools array`);
          err.code = 'MALFORMED_NAMESPACE_TOOL';
          throw err;
        }

        const ns = tool.name;
        const aliasNs = getGenuineMcpAlias(ns, trusted);

        for (const subTool of tool.tools) {
          if (!subTool || typeof subTool !== 'object') {
            const err = new Error(`Namespace "${ns}" contains malformed subtool`);
            err.code = 'MALFORMED_TOOL_SPEC';
            throw err;
          }
          if (subTool.type === 'namespace') {
            const err = new Error(`Nested namespace tools are not supported: ${ns}/${subTool.name}`);
            err.code = 'NESTED_NAMESPACE_UNSUPPORTED';
            throw err;
          }
          if (subTool.type === 'custom') {
            const err = new Error(`Custom tool format not supported in namespace: ${ns}/${subTool.name}`);
            err.code = 'UNSUPPORTED_CUSTOM_TOOL';
            throw err;
          }
          if (subTool.type === 'web_search') {
            const err = new Error(`Web search tool not supported in namespace: ${ns}/${subTool.name}`);
            err.code = 'UNSUPPORTED_SEARCH_TOOL';
            throw err;
          }
          if (subTool.type !== 'function') {
            const err = new Error(`Namespace "${ns}" contains unsupported subtool type: ${subTool.type}`);
            err.code = 'UNSUPPORTED_TOOL_SHAPE';
            throw err;
          }
          if (typeof subTool.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(subTool.name)) {
            const err = new Error(`Invalid tool name in namespace "${ns}": ${subTool.name}`);
            err.code = 'INVALID_TOOL_NAME';
            throw err;
          }
          if (subTool.name.includes('__ns__')) {
            const err = new Error(`Subtool name contains reserved delimiter: ${subTool.name}`);
            err.code = 'TOOL_COLLISION';
            throw err;
          }

          const flattenedName = `${ns}__ns__${subTool.name}`;
          if (flattenedName.length > 64) {
            const err = new Error(`Flattened tool name exceeds 64 characters: ${flattenedName}`);
            err.code = 'TOOL_NAME_TOO_LONG';
            throw err;
          }
          if (allToolNames.has(flattenedName) || allAliasNames.has(flattenedName)) {
            const err = new Error(`Tool collision detected for ${flattenedName}`);
            err.code = 'TOOL_COLLISION';
            throw err;
          }

          let aliasFlattened = null;
          if (aliasNs) {
            const candidate = `${aliasNs}__ns__${subTool.name}`;
            if (candidate.length <= 64) {
              if (allToolNames.has(candidate) || allAliasNames.has(candidate)) {
                const err = new Error(`Tool alias collision detected for ${candidate}`);
                err.code = 'TOOL_COLLISION';
                throw err;
              }
              aliasFlattened = candidate;
            }
          }

          // Check collision with historical registered tools
          if (historyMapping.has(flattenedName)) {
            const existing = historyMapping.get(flattenedName);
            if (
              existing.originalName !== subTool.name ||
              (existing.namespace !== ns && getGenuineMcpAlias(existing.namespace, trusted) !== ns)
            ) {
              const err = new Error(`Tool collision with previously registered tool: ${flattenedName}`);
              err.code = 'TOOL_COLLISION';
              throw err;
            }
          }
          if (aliasFlattened && historyMapping.has(aliasFlattened)) {
            const existing = historyMapping.get(aliasFlattened);
            if (
              existing.originalName !== subTool.name ||
              (existing.namespace !== ns && getGenuineMcpAlias(existing.namespace, trusted) !== ns)
            ) {
              const err = new Error(`Tool collision with previously registered tool: ${aliasFlattened}`);
              err.code = 'TOOL_COLLISION';
              throw err;
            }
          }

          allToolNames.add(flattenedName);
          if (aliasFlattened) {
            allAliasNames.add(aliasFlattened);
          }

          // Request-local mapping for response unflattening and tool_choice
          const toolMapping = {
            namespace: ns,
            originalName: subTool.name,
          };
          currentRequestMapping.set(flattenedName, toolMapping);

          // History mapping entry for history rewriting
          const histMapping = {
            namespace: ns,
            originalName: subTool.name,
            canonicalFlattenedName: flattenedName,
          };
          historyMapping.set(flattenedName, histMapping);
          stagedHistoryEntries.set(flattenedName, histMapping);

          if (aliasFlattened) {
            historyMapping.set(aliasFlattened, histMapping);
            stagedHistoryEntries.set(aliasFlattened, histMapping);
          }

          flattenedTools.push({
            ...subTool,
            type: 'function',
            name: flattenedName,
          });
        }
      } else if (tool.type === 'function') {
        if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
          const err = new Error(`Invalid function tool name: ${tool.name}`);
          err.code = 'INVALID_TOOL_NAME';
          throw err;
        }
        if (tool.name.includes('__ns__')) {
          const err = new Error(`Tool name contains reserved delimiter: ${tool.name}`);
          err.code = 'TOOL_COLLISION';
          throw err;
        }
        if (allToolNames.has(tool.name) || allAliasNames.has(tool.name)) {
          const err = new Error(`Duplicate tool name: ${tool.name}`);
          err.code = 'TOOL_COLLISION';
          throw err;
        }
        allToolNames.add(tool.name);
        flattenedTools.push(tool);
      } else if (tool.type === 'custom') {
        if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
          const err = new Error(`Invalid custom tool name: ${tool.name}`);
          err.code = 'INVALID_TOOL_NAME';
          throw err;
        }
        if (tool.name.includes('__ns__')) {
          const err = new Error(`Tool name contains reserved delimiter: ${tool.name}`);
          err.code = 'TOOL_COLLISION';
          throw err;
        }
        if (allToolNames.has(tool.name) || allAliasNames.has(tool.name)) {
          const err = new Error(`Duplicate tool name: ${tool.name}`);
          err.code = 'TOOL_COLLISION';
          throw err;
        }
        allToolNames.add(tool.name);
        flattenedTools.push({
          type: 'function',
          name: tool.name,
          description: tool.description || '',
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: `Input for ${tool.name}` },
            },
          },
        });
      } else if (tool.type === 'web_search') {
        continue;
      } else {
        const err = new Error(`Unsupported tool type: ${tool.type}`);
        err.code = 'UNSUPPORTED_TOOL_SHAPE';
        throw err;
      }
    }
    body.tools = flattenedTools;
  }

  // Rewrite and validate tool_choice against currentRequestMapping
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') {
      if (!['auto', 'none', 'required'].includes(body.tool_choice)) {
        const err = new Error(`Invalid string tool_choice: ${body.tool_choice}`);
        err.code = 'INVALID_TOOL_CHOICE';
        throw err;
      }
    } else if (typeof body.tool_choice === 'object' && body.tool_choice !== null) {
      if (body.tool_choice.type === 'function') {
        const topName = body.tool_choice.name;
        const fnObjName = body.tool_choice.function?.name;
        if (topName !== undefined && typeof topName !== 'string') {
          const err = new Error('Function tool_choice name must be a string');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        if (fnObjName !== undefined && typeof fnObjName !== 'string') {
          const err = new Error('Function tool_choice function.name must be a string');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        if (topName && fnObjName && topName !== fnObjName) {
          const err = new Error('Conflicting tool_choice names in "name" and "function.name"');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        const fnName = topName || fnObjName;
        if (!fnName) {
          const err = new Error('Function tool_choice missing function name');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        if (body.tool_choice.namespace !== undefined) {
          if (typeof body.tool_choice.namespace !== 'string') {
            const err = new Error('tool_choice namespace must be a string');
            err.code = 'INVALID_TOOL_CHOICE';
            throw err;
          }
          const resolved = resolveCurrentToolMapping(body.tool_choice.namespace, fnName, currentRequestMapping, trusted);
          if (!resolved) {
            const err = new Error(`tool_choice references unregistered tool: ${body.tool_choice.namespace}/${fnName}`);
            err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
            throw err;
          }
          const targetName = resolved.flattenedName;
          if (body.tool_choice.name) {
            body.tool_choice.name = targetName;
          }
          if (body.tool_choice.function?.name) {
            body.tool_choice.function.name = targetName;
          }
          delete body.tool_choice.namespace;
        } else {
          if (!allToolNames.has(fnName)) {
            const targetName = resolveFlattenedToolName(fnName, currentRequestMapping, trusted);
            if (!targetName) {
              const err = new Error(`tool_choice references unregistered tool: ${fnName}`);
              err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
              throw err;
            }
            if (body.tool_choice.name) body.tool_choice.name = targetName;
            if (body.tool_choice.function?.name) body.tool_choice.function.name = targetName;
          }
        }
      } else if (body.tool_choice.type === 'namespace') {
        if (!body.tool_choice.name || typeof body.tool_choice.name !== 'string') {
          const err = new Error('Namespace tool_choice missing namespace name');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        if (body.tool_choice.function?.name) {
          if (typeof body.tool_choice.function.name !== 'string') {
            const err = new Error('Namespace tool_choice function.name must be a string');
            err.code = 'INVALID_TOOL_CHOICE';
            throw err;
          }
          const ns = body.tool_choice.name;
          const fn = body.tool_choice.function.name;
          const resolved = resolveCurrentToolMapping(ns, fn, currentRequestMapping, trusted);
          if (!resolved) {
            const err = new Error(`tool_choice references unregistered tool: ${ns}/${fn}`);
            err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
            throw err;
          }
          body.tool_choice = {
            type: 'function',
            function: { name: resolved.flattenedName },
          };
        } else {
          const err = new Error('Namespace-wide tool_choice is unsupported in flatten mode');
          err.code = 'UNSUPPORTED_TOOL_CHOICE_NAMESPACE_WIDE';
          throw err;
        }
      } else if (body.tool_choice.type === 'allowed_tools') {
        if (!Array.isArray(body.tool_choice.tools)) {
          const err = new Error('allowed_tools tool_choice must have tools array');
          err.code = 'INVALID_TOOL_CHOICE';
          throw err;
        }
        for (let idx = 0; idx < body.tool_choice.tools.length; idx++) {
          const t = body.tool_choice.tools[idx];
          if (!t || typeof t !== 'object') {
            const err = new Error('Each item in allowed_tools.tools must be an object');
            err.code = 'INVALID_TOOL_CHOICE';
            throw err;
          }
          if (t.type === 'function') {
            const topName = t.name;
            const fnObjName = t.function?.name;
            if (topName !== undefined && typeof topName !== 'string') {
              const err = new Error('allowed_tools function name must be a string');
              err.code = 'INVALID_TOOL_CHOICE';
              throw err;
            }
            if (fnObjName !== undefined && typeof fnObjName !== 'string') {
              const err = new Error('allowed_tools function.name must be a string');
              err.code = 'INVALID_TOOL_CHOICE';
              throw err;
            }
            if (topName && fnObjName && topName !== fnObjName) {
              const err = new Error('Conflicting allowed_tools function names in "name" and "function.name"');
              err.code = 'INVALID_TOOL_CHOICE';
              throw err;
            }
            const fnName = topName || fnObjName;
            if (!fnName) {
              const err = new Error('allowed_tools function item missing function name');
              err.code = 'INVALID_TOOL_CHOICE';
              throw err;
            }
            if (t.namespace !== undefined) {
              if (typeof t.namespace !== 'string') {
                const err = new Error('allowed_tools namespace must be a string');
                err.code = 'INVALID_TOOL_CHOICE';
                throw err;
              }
              const resolved = resolveCurrentToolMapping(t.namespace, fnName, currentRequestMapping, trusted);
              if (!resolved) {
                const err = new Error(`allowed_tools references unregistered tool: ${t.namespace}/${fnName}`);
                err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
                throw err;
              }
              const targetName = resolved.flattenedName;
              if (t.name) t.name = targetName;
              if (t.function?.name) t.function.name = targetName;
              delete t.namespace;
            } else {
              if (!allToolNames.has(fnName)) {
                const targetName = resolveFlattenedToolName(fnName, currentRequestMapping, trusted);
                if (!targetName) {
                  const err = new Error(`allowed_tools references unregistered tool: ${fnName}`);
                  err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
                  throw err;
                }
                if (t.name) t.name = targetName;
                if (t.function?.name) t.function.name = targetName;
              }
            }
          } else if (t.type === 'namespace') {
            if (!t.name || typeof t.name !== 'string') {
              const err = new Error('allowed_tools namespace item missing namespace name');
              err.code = 'INVALID_TOOL_CHOICE';
              throw err;
            }
            if (!t.function?.name || typeof t.function.name !== 'string') {
              const err = new Error('Namespace-wide allowed_tools is unsupported in flatten mode');
              err.code = 'UNSUPPORTED_TOOL_CHOICE_NAMESPACE_WIDE';
              throw err;
            }
            const resolved = resolveCurrentToolMapping(t.name, t.function.name, currentRequestMapping, trusted);
            if (!resolved) {
              const err = new Error(`allowed_tools references unregistered tool: ${t.name}/${t.function.name}`);
              err.code = 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL';
              throw err;
            }
            body.tool_choice.tools[idx] = { type: 'function', function: { name: resolved.flattenedName } };
          } else {
            const err = new Error(`Unsupported tool type in allowed_tools: ${t.type}`);
            err.code = 'UNSUPPORTED_TOOL_CHOICE_TYPE';
            throw err;
          }
        }
      } else {
        const err = new Error(`Unsupported tool_choice type: ${body.tool_choice.type}`);
        err.code = 'UNSUPPORTED_TOOL_CHOICE_TYPE';
        throw err;
      }
    } else {
      const err = new Error('Invalid tool_choice value');
      err.code = 'INVALID_TOOL_CHOICE';
      throw err;
    }
  }

  // Rewrite input items for conversation history
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      rewriteInputItem(item, historyMapping);
    }
  }

  // Transactional commit to historyRegistry only after full request validation succeeds
  if (historyRegistry && typeof historyRegistry.set === 'function') {
    for (const [key, val] of stagedHistoryEntries) {
      if (historyRegistry.has(key)) {
        historyRegistry.delete(key);
      } else if (historyRegistry.size >= MAX_HISTORY_REGISTRY_ENTRIES) {
        const oldestKey = historyRegistry.keys().next().value;
        historyRegistry.delete(oldestKey);
      }
      historyRegistry.set(key, val);
    }
  }

  return { nameMapping: currentRequestMapping };
}

function rewriteFunctionCall(call, historyMapping) {
  if (typeof call.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(call.name)) {
    const err = new Error(`History contains malformed tool name: ${call.namespace ? `${call.namespace}/` : ''}${call.name}`);
    err.code = 'UNKNOWN_HISTORY_TOOL';
    throw err;
  }
  if (call.namespace !== undefined) {
    if (typeof call.namespace !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(call.namespace) || call.namespace.includes('__ns__')) {
      const err = new Error(`History contains malformed namespace: ${call.namespace}`);
      err.code = 'UNKNOWN_HISTORY_TOOL';
      throw err;
    }
    if (call.name.includes('__ns__')) {
      const err = new Error(`History contains malformed tool name: ${call.namespace}/${call.name}`);
      err.code = 'UNKNOWN_HISTORY_TOOL';
      throw err;
    }
    const flattenedName = `${call.namespace}__ns__${call.name}`;
    const mapping = historyMapping.get(flattenedName);
    if (!mapping) {
      const err = new Error(`History contains unregistered namespace tool: ${call.namespace}/${call.name}`);
      err.code = 'UNKNOWN_HISTORY_TOOL';
      throw err;
    }
    call.name = mapping.canonicalFlattenedName ?? `${mapping.namespace}__ns__${mapping.originalName}`;
    delete call.namespace;
  } else if (call.name.includes('__ns__')) {
    const mapping = historyMapping.get(call.name);
    if (!mapping) {
      const err = new Error(`History contains unregistered namespace tool: ${call.name}`);
      err.code = 'UNKNOWN_HISTORY_TOOL';
      throw err;
    }
    call.name = mapping.canonicalFlattenedName ?? call.name;
  }
}

function rewriteInputItem(item, historyMapping) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'function_call') {
    rewriteFunctionCall(item, historyMapping);
  }
  if (item.type === 'message' && Array.isArray(item.content)) {
    for (const c of item.content) {
      if (c && typeof c === 'object' && c.type === 'function_call') {
        rewriteFunctionCall(c, historyMapping);
      }
    }
  }
}

export function unflattenResponseObject(obj, nameMapping) {
  if (!obj || typeof obj !== 'object') return obj;

  if (obj.type === 'function_call' && typeof obj.name === 'string') {
    if (nameMapping.has(obj.name)) {
      const mapping = nameMapping.get(obj.name);
      obj.name = mapping.originalName;
      obj.namespace = mapping.namespace;
    } else if (obj.name.includes('__ns__')) {
      const err = new Error(`Unrecognized flattened tool identity: ${obj.name}`);
      err.code = 'UNRECOGNIZED_TOOL_IDENTITY';
      throw err;
    }
  }

  if (obj.type === 'response.function_call_arguments.done' && typeof obj.name === 'string') {
    if (nameMapping.has(obj.name)) {
      const mapping = nameMapping.get(obj.name);
      obj.name = mapping.originalName;
      obj.namespace = mapping.namespace;
    } else if (obj.name.includes('__ns__')) {
      const err = new Error(`Unrecognized flattened tool identity: ${obj.name}`);
      err.code = 'UNRECOGNIZED_TOOL_IDENTITY';
      throw err;
    }
  }

  if (obj.item && typeof obj.item === 'object') {
    unflattenResponseObject(obj.item, nameMapping);
  }

  if (Array.isArray(obj.output)) {
    for (const item of obj.output) {
      unflattenResponseObject(item, nameMapping);
    }
  }

  if (obj.response && typeof obj.response === 'object') {
    unflattenResponseObject(obj.response, nameMapping);
  }

  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      unflattenResponseObject(item, nameMapping);
    }
  }

  return obj;
}

export function handleRelayRequest(request, response, options) {
  const {
    upstream,
    compatibilityMode = 'standard',
    maxBodyBytes = 8 * 1024 * 1024,
    historyRegistry,
    trustedMcpServers,
  } = options;
  let target;
  try {
    target = relayTarget(request.url ?? '/', upstream);
  } catch {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { message: 'Invalid request URL', code: 'invalid_url' } }));
    return;
  }
  const headers = { ...request.headers, host: target.host };
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];

  const isResponsesPost =
    request.method === 'POST' &&
    (target.pathname.endsWith('/responses') || target.pathname.endsWith('/responses/'));

  if (compatibilityMode !== 'flatten_namespaces' || !isResponsesPost) {
    const transport = target.protocol === 'https:' ? https : http;
    let upstreamReq = null;
    let isTerminated = false;

    function cleanup() {
      if (isTerminated) return;
      isTerminated = true;
      if (upstreamReq) {
        try { upstreamReq.destroy(); } catch { /* ignore */ }
      }
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'Upstream model service error', code: 'upstream_error' } }));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }

    request.on('error', cleanup);
    response.on('error', cleanup);
    response.on('close', () => {
      if (!response.writableEnded) cleanup();
    });

    upstreamReq = transport.request(target, { method: request.method, headers }, (upstreamResponse) => {
      if (isTerminated) {
        upstreamResponse.destroy();
        return;
      }
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders['proxy-authenticate'];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', cleanup);
    });

    upstreamReq.setTimeout(30 * 60 * 1000, cleanup);
    upstreamReq.on('error', cleanup);
    request.pipe(upstreamReq);
    return;
  }

  let isTerminated = false;
  let upstreamReq = null;
  let upstreamRes = null;
  let decompressor = null;

  function terminate(status, clientMsg, code) {
    if (isTerminated) return;
    isTerminated = true;
    if (decompressor) {
      try {
        decompressor.destroy();
      } catch {
        /* ignore */
      }
    }
    if (upstreamReq) {
      try {
        upstreamReq.destroy();
      } catch {
        /* ignore */
      }
    }
    if (upstreamRes) {
      try {
        upstreamRes.destroy();
      } catch {
        /* ignore */
      }
    }
    if (!response.headersSent && status) {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: clientMsg, code: code || 'relay_error' } }));
    } else if (!response.writableEnded) {
      response.destroy();
    }
  }

  request.on('error', () => terminate(null));
  response.on('error', () => terminate(null));
  response.on('close', () => {
    if (!response.writableEnded) terminate(null);
  });

  let bodyBuffer = '';
  const bodyDecoder = new StringDecoder('utf8');
  let bodyOverflow = false;

  request.on('data', (chunk) => {
    if (bodyOverflow || isTerminated) return;
    bodyBuffer += bodyDecoder.write(chunk);
    if (Buffer.byteLength(bodyBuffer, 'utf8') > maxBodyBytes) {
      bodyOverflow = true;
      request.pause();
      terminate(413, 'Payload Too Large', 'payload_too_large');
      response.on('finish', () => {
        try {
          request.destroy();
        } catch {
          /* ignore */
        }
      });
    }
  });

  request.on('end', () => {
    if (bodyOverflow || isTerminated) return;
    bodyBuffer += bodyDecoder.end();
    let body;
    try {
      body = JSON.parse(bodyBuffer);
    } catch {
      terminate(400, 'Invalid JSON request body', 'invalid_json');
      return;
    }

    let nameMapping;
    try {
      const result = flattenResponsesRequest(body, { historyRegistry, trustedMcpServers });
      nameMapping = result.nameMapping;
    } catch (err) {
      terminate(400, err.message, err.code || 'bad_request');
      return;
    }

    const modifiedBody = JSON.stringify(body);
    headers['content-length'] = Buffer.byteLength(modifiedBody, 'utf8');
    delete headers['transfer-encoding'];
    headers['accept-encoding'] = 'identity';

    const transport = target.protocol === 'https:' ? https : http;
    upstreamReq = transport.request(
      target,
      {
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        upstreamRes = upstreamResponse;
        if (isTerminated) {
          upstreamResponse.destroy();
          return;
        }

        upstreamResponse.on('error', () => terminate(502, 'Upstream model service error', 'upstream_error'));

        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders.connection;
        delete responseHeaders['proxy-authenticate'];

        const contentEncoding = (responseHeaders['content-encoding'] || 'identity').toLowerCase();
        delete responseHeaders['content-encoding'];

        let decompressedStream = upstreamResponse;
        if (contentEncoding === 'gzip') {
          decompressor = createGunzip();
          decompressedStream = upstreamResponse.pipe(decompressor);
        } else if (contentEncoding === 'deflate') {
          decompressor = createInflate();
          decompressedStream = upstreamResponse.pipe(decompressor);
        } else if (contentEncoding !== 'identity') {
          terminate(502, `Unsupported upstream content-encoding: ${contentEncoding}`, 'unsupported_encoding');
          return;
        }

        if (decompressor) {
          decompressor.on('error', () => {
            try {
              decompressor.destroy();
            } catch {
              /* ignore */
            }
            try {
              upstreamResponse.destroy();
            } catch {
              /* ignore */
            }
            terminate(502, 'Upstream model service error', 'upstream_error');
          });
        }

        const contentType = upstreamResponse.headers['content-type'] ?? '';
        if (contentType.includes('text/event-stream')) {
          delete responseHeaders['content-length'];
          responseHeaders['transfer-encoding'] = 'chunked';
          response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);

          const sseParser = new IncrementalSseParser({ maxEventBytes: 8 * 1024 * 1024 });
          const sseQueue = [];
          let sseQueueBytes = 0;
          const MAX_SSE_QUEUE_BYTES = 8 * 1024 * 1024;
          let upstreamEnded = false;

          function pauseUpstream() {
            if (decompressor && !decompressor.isPaused()) decompressor.pause();
            if (!upstreamResponse.isPaused()) upstreamResponse.pause();
          }

          function resumeUpstream() {
            if (decompressor && decompressor.isPaused()) decompressor.resume();
            if (upstreamResponse.isPaused()) upstreamResponse.resume();
          }

          function flushSseQueue() {
            while (sseQueue.length > 0) {
              const block = sseQueue[0];
              const ok = response.write(block);
              sseQueueBytes -= Buffer.byteLength(block, 'utf8');
              sseQueue.shift();
              if (!ok) {
                return false;
              }
            }
            return true;
          }

          response.on('drain', () => {
            const ok = flushSseQueue();
            if (ok) {
              if (upstreamEnded && sseQueue.length === 0) {
                response.end();
              } else {
                resumeUpstream();
              }
            }
          });

          decompressedStream.on('data', (chunk) => {
            if (isTerminated) return;
            try {
              const events = sseParser.feed(chunk);
              for (const ev of events) {
                const serialized = transformParsedSseEvent(ev, nameMapping);
                const blockBytes = Buffer.byteLength(serialized, 'utf8');
                if (sseQueueBytes + blockBytes > MAX_SSE_QUEUE_BYTES) {
                  throw new Error('SSE_QUEUE_BUFFER_EXCEEDED');
                }
                sseQueue.push(serialized);
                sseQueueBytes += blockBytes;
              }
              const ok = flushSseQueue();
              if (!ok) {
                pauseUpstream();
              }
            } catch {
              decompressedStream.destroy();
              terminate(502, 'Failed to process SSE stream', 'sse_error');
            }
          });

          decompressedStream.on('end', () => {
            if (isTerminated) return;
            upstreamEnded = true;
            try {
              const events = sseParser.end();
              for (const ev of events) {
                const serialized = transformParsedSseEvent(ev, nameMapping);
                const blockBytes = Buffer.byteLength(serialized, 'utf8');
                if (sseQueueBytes + blockBytes > MAX_SSE_QUEUE_BYTES) {
                  throw new Error('SSE_QUEUE_BUFFER_EXCEEDED');
                }
                sseQueue.push(serialized);
                sseQueueBytes += blockBytes;
              }
              const ok = flushSseQueue();
              if (ok && sseQueue.length === 0) {
                response.end();
              }
            } catch {
              terminate(502, 'Failed to process SSE stream', 'sse_error');
            }
          });
        } else if (contentType.includes('application/json')) {
          let resBody = '';
          const resDecoder = new StringDecoder('utf8');
          const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
          let jsonOverflow = false;

          decompressedStream.on('data', (chunk) => {
            if (jsonOverflow || isTerminated) return;
            resBody += resDecoder.write(chunk);
            if (Buffer.byteLength(resBody, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
              jsonOverflow = true;
              decompressedStream.destroy();
              terminate(502, 'Response payload too large', 'response_too_large');
            }
          });

          decompressedStream.on('end', () => {
            if (jsonOverflow || isTerminated) return;
            resBody += resDecoder.end();
            try {
              const parsed = JSON.parse(resBody);
              unflattenResponseObject(parsed, nameMapping);
              const transformedJson = JSON.stringify(parsed);
              responseHeaders['content-length'] = Buffer.byteLength(transformedJson, 'utf8');
              delete responseHeaders['transfer-encoding'];
              response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);
              response.end(transformedJson);
            } catch {
              terminate(502, 'Upstream model service error', 'upstream_error');
            }
          });
        } else {
          response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);
          decompressedStream.pipe(response);
        }
      },
    );

    upstreamReq.setTimeout(30 * 60 * 1000, () => {
      terminate(504, 'Upstream model service timeout', 'gateway_timeout');
    });
    upstreamReq.on('error', () => {
      terminate(502, 'Upstream model service error', 'upstream_error');
    });
    upstreamReq.end(modifiedBody);
  });
}

export function createRelayServer(options) {
  const {
    upstream,
    compatibilityMode = 'standard',
    maxConcurrent = 4,
    maxBodyBytes = 8 * 1024 * 1024,
    historyRegistry = new Map(),
    trustedMcpServers = ['file_tools'],
  } = options;
  let inFlight = 0;

  return http.createServer((request, response) => {
    if (inFlight >= maxConcurrent) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'Server busy', code: 'too_many_requests' } }));
      return;
    }
    inFlight++;
    const decrement = () => {
      inFlight = Math.max(0, inFlight - 1);
      response.removeListener('finish', decrement);
      response.removeListener('close', decrement);
    };
    response.on('finish', decrement);
    response.on('close', decrement);

    handleRelayRequest(request, response, {
      upstream,
      compatibilityMode,
      maxBodyBytes,
      historyRegistry,
      trustedMcpServers,
    });
  });
}

async function publishManagedCa(proxyHome, sharedDirectory) {
  const proxyDirectory = join(proxyHome, 'proxy');
  await mkdir(sharedDirectory, { recursive: true });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const candidates = await readdir(proxyDirectory).catch(() => []);
    const bundles = candidates.filter((name) => /^ca-(?!bundle-).*\.pem$/.test(name));
    for (const bundle of bundles) {
      const source = join(proxyDirectory, bundle);
      const metadata = await stat(source).catch(() => undefined);
      if (!metadata?.size) continue;
      const temporary = join(sharedDirectory, `ca.pem.${process.pid}.tmp`);
      await copyFile(source, temporary);
      await rename(temporary, join(sharedDirectory, 'ca.pem'));
      await writeFile(join(sharedDirectory, 'ready'), 'ready\n', { encoding: 'utf8' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('managed proxy CA was not published');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const isDirectRun = process.argv[1] ? normalize(fileURLToPath(import.meta.url)) === normalize(process.argv[1]) : false;

if (isDirectRun) {
  const relayEnabled = process.env.LOCAL_ENGINEER_MODEL_RELAY_ENABLED !== 'false';
  const upstream = relayEnabled ? new URL(requiredEnvironment('LOCAL_ENGINEER_MODEL_UPSTREAM')) : undefined;
  const windows = process.platform === 'win32';
  const proxyHome = process.env.CODEX_HOME ?? (windows ? 'C:/local-engineer/codex-home' : '/home/codex/.codex');
  const sharedDirectory =
    process.env.LOCAL_ENGINEER_PROXY_SHARED ?? (windows ? 'C:/local-engineer/proxy-shared' : '/proxy-shared');
  const proxyExecutable =
    process.env.LOCAL_ENGINEER_PROXY_EXECUTABLE ??
    (windows ? 'C:/local-engineer/codex-network-proxy.exe' : '/usr/local/bin/codex-network-proxy');
  const relayPort = 8090;
  const relayBindAddress = process.env.LOCAL_ENGINEER_MODEL_RELAY_BIND_ADDRESS ?? (windows ? undefined : '0.0.0.0');
  const compatibilityMode = process.env.LOCAL_ENGINEER_RESPONSES_COMPATIBILITY ?? 'standard';

  if (
    !relayBindAddress ||
    isIP(relayBindAddress) !== 4 ||
    (windows && !/^10\.\d{1,3}\.\d{1,3}\.2$/.test(relayBindAddress))
  ) {
    throw new Error('LOCAL_ENGINEER_MODEL_RELAY_BIND_ADDRESS_INVALID');
  }

  const proxy = spawn(proxyExecutable, [], {
    env: process.env,
    stdio: 'inherit',
  });

  proxy.once('exit', (code, signal) => {
    process.stderr.write(`network proxy exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
    process.exit(code ?? 1);
  });

  const relay = relayEnabled
    ? createRelayServer({ upstream, compatibilityMode })
    : undefined;

  if (relay) {
    relay.listen(relayPort, relayBindAddress, () => {
      process.stdout.write(`model relay listening on ${relayBindAddress}:${relayPort}; target=${upstream.origin}; compat=${compatibilityMode}\n`);
    });
  }

  publishManagedCa(proxyHome, sharedDirectory).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    proxy.kill('SIGTERM');
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      relay?.close();
      proxy.kill(signal);
    });
  }
}
