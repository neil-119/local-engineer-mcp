import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createRelayServer,
  flattenResponsesRequest,
  getGenuineMcpAlias,
  IncrementalSseParser,
  MAX_HISTORY_REGISTRY_ENTRIES,
  relayTarget,
  serializeSseEvent,
  transformParsedSseEvent,
  transformSseBlock,
  unflattenResponseObject,
} from '../container/proxy-sidecar.mjs';

describe('proxy-sidecar namespace flattening adapter', () => {
  describe('IncrementalSseParser', () => {
    it('parses CRLF (\\r\\n\\r\\n) delimited events correctly', () => {
      const parser = new IncrementalSseParser();
      const raw = 'event: test\r\ndata: {"foo":"bar"}\r\n\r\n';
      const events = [...parser.feed(Buffer.from(raw)), ...parser.end()];
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('test');
      expect(events[0].data).toBe('{"foo":"bar"}');
    });

    it('parses LF (\\n\\n) and CR (\\r\\r) delimited events correctly', () => {
      const parser = new IncrementalSseParser();
      const rawLF = 'event: e1\ndata: {"v":1}\n\n';
      const rawCR = 'event: e2\rdata: {"v":2}\r\r';
      const events1 = parser.feed(Buffer.from(rawLF));
      const events2 = [...parser.feed(Buffer.from(rawCR)), ...parser.end()];
      expect(events1).toHaveLength(1);
      expect(events1[0].eventType).toBe('e1');
      expect(events1[0].data).toBe('{"v":1}');
      expect(events2).toHaveLength(1);
      expect(events2[0].eventType).toBe('e2');
      expect(events2[0].data).toBe('{"v":2}');
    });

    it('joins multiple data: lines within the same event with \\n per SSE specification', () => {
      const parser = new IncrementalSseParser();
      const raw = 'data: line 1\r\ndata: line 2\r\ndata: line 3\r\n\r\n';
      const events = [...parser.feed(Buffer.from(raw)), ...parser.end()];
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('line 1\nline 2\nline 3');
    });

    it('correctly handles delimiters and chunks split across boundaries', () => {
      const parser = new IncrementalSseParser();
      // Split \r\n\r\n across chunks
      const chunk1 = Buffer.from('data: hello\r');
      const chunk2 = Buffer.from('\n\r');
      const chunk3 = Buffer.from('\ndata: world\n\n');

      const events1 = parser.feed(chunk1);
      expect(events1).toHaveLength(0);

      const events2 = parser.feed(chunk2);
      expect(events2).toHaveLength(0);

      const events3 = parser.feed(chunk3);
      expect(events3).toHaveLength(2);
      expect(events3[0].data).toBe('hello');
      expect(events3[1].data).toBe('world');
    });

    it('correctly decodes multibyte UTF-8 characters split across chunk boundaries', () => {
      const parser = new IncrementalSseParser();
      // Emoji 😀 is 4 bytes in UTF-8: 0xF0 0x9F 0x98 0x80
      const chunk1 = Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xf0, 0x9f]); // "data: " + half of emoji
      const chunk2 = Buffer.from([0x98, 0x80, 0x0a, 0x0a]); // other half of emoji + "\n\n"

      const events1 = parser.feed(chunk1);
      expect(events1).toHaveLength(0);

      const events2 = [...parser.feed(chunk2), ...parser.end()];
      expect(events2).toHaveLength(1);
      expect(events2[0].data).toBe('😀');
    });

    it('enforces maximum event byte limits and fails safely', () => {
      const parser = new IncrementalSseParser({ maxEventBytes: 32 });
      const oversized = Buffer.from('data: ' + 'A'.repeat(50) + '\n\n');
      expect(() => parser.feed(oversized)).toThrow('SSE_EVENT_BYTE_LIMIT_EXCEEDED');
    });

    it('enforces byte limits on chunks without any newlines', () => {
      const parser = new IncrementalSseParser({ maxEventBytes: 32 });
      // Stream 50 bytes without newline delimiter
      const continuous = Buffer.from('A'.repeat(50));
      expect(() => parser.feed(continuous)).toThrow('SSE_EVENT_BYTE_LIMIT_EXCEEDED');
    });

    it('handles multiple coalesced valid events in one chunk whose aggregate size exceeds maxEventBytes', () => {
      // Each event is ~20 bytes, total chunk is ~60 bytes, but maxEventBytes is 35 bytes
      const parser = new IncrementalSseParser({ maxEventBytes: 35 });
      const coalesced = Buffer.from('data: event1-body\n\n' + 'data: event2-body\n\n' + 'data: event3-body\n\n');
      expect(coalesced.byteLength).toBeGreaterThan(35);
      const events = [...parser.feed(coalesced), ...parser.end()];
      expect(events).toHaveLength(3);
      expect(events[0].data).toBe('event1-body');
      expect(events[1].data).toBe('event2-body');
      expect(events[2].data).toBe('event3-body');
    });

    it('produces identical events regardless of arbitrary chunk boundaries', () => {
      const rawText =
        'event: message\r\nid: 1\r\ndata: first line\r\ndata: second line\r\n\r\n' +
        ': comment line\r\nevent: custom\r\ndata: {"status":"ok"}\n\n' +
        'data: third event\r\r';
      const rawBuffer = Buffer.from(rawText);

      // Baseline: parse all in one chunk
      const parserBaseline = new IncrementalSseParser();
      const baselineEvents = [...parserBaseline.feed(rawBuffer), ...parserBaseline.end()];

      // Test 1: parse byte by byte (1 byte chunks)
      const parserByteByByte = new IncrementalSseParser();
      const byteEvents: typeof baselineEvents = [];
      for (let i = 0; i < rawBuffer.length; i++) {
        byteEvents.push(...parserByteByByte.feed(rawBuffer.subarray(i, i + 1)));
      }
      byteEvents.push(...parserByteByByte.end());
      expect(byteEvents).toEqual(baselineEvents);

      // Test 2: parse arbitrary uneven chunk sizes (2, 3, 5, 7, 11 bytes)
      for (const chunkSize of [2, 3, 5, 7, 11]) {
        const parserChunked = new IncrementalSseParser();
        const chunkedEvents: typeof baselineEvents = [];
        for (let i = 0; i < rawBuffer.length; i += chunkSize) {
          chunkedEvents.push(...parserChunked.feed(rawBuffer.subarray(i, i + chunkSize)));
        }
        chunkedEvents.push(...parserChunked.end());
        expect(chunkedEvents).toEqual(baselineEvents);
      }
    });

    it('serializes and transforms parsed SSE events cleanly', () => {
      const event = {
        eventType: 'test.event',
        id: '123',
        data: '{"type":"function_call","name":"ns__ns__fn"}',
        otherLines: [': comment'],
      };
      const mapping = new Map([['ns__ns__fn', { namespace: 'ns', originalName: 'fn' }]]);
      const transformed = transformParsedSseEvent(event, mapping);
      expect(transformed).toContain('event: test.event');
      expect(transformed).toContain('id: 123');
      expect(transformed).toContain(': comment');
      expect(transformed).toContain('"name":"fn"');
      expect(transformed).toContain('"namespace":"ns"');

      const plain = serializeSseEvent({
        eventType: 'heartbeat',
        id: '456',
        data: 'ping',
        otherLines: [],
      });
      expect(plain).toBe('event: heartbeat\nid: 456\ndata: ping\n\n');
    });
  });

  describe('flattenResponsesRequest validation & rewriting', () => {
    it('preserves top-level function tools and returns empty mapping when no namespaces exist', () => {
      const body = {
        model: 'test-model',
        tools: [{ type: 'function', name: 'exec_command', description: 'Run shell command' }],
      };
      const { nameMapping } = flattenResponsesRequest(body);
      expect(nameMapping.size).toBe(0);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('exec_command');
    });

    it('flattens namespaced tools with __ns__ delimiter and records mapping', () => {
      const body = {
        model: 'test-model',
        tools: [
          { type: 'function', name: 'exec_command' },
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [
              { type: 'function', name: 'read_file', parameters: { type: 'object' } },
              { type: 'function', name: 'write_file', parameters: { type: 'object' } },
            ],
          },
        ],
      };
      const { nameMapping } = flattenResponsesRequest(body);
      expect(nameMapping.size).toBe(2);
      expect(nameMapping.get('mcp__file_tools__ns__read_file')).toEqual({
        namespace: 'mcp__file_tools',
        originalName: 'read_file',
      });
      expect(nameMapping.get('mcp__file_tools__ns__write_file')).toEqual({
        namespace: 'mcp__file_tools',
        originalName: 'write_file',
      });

      expect(body.tools).toHaveLength(3);
      expect(body.tools[0]).toEqual({ type: 'function', name: 'exec_command' });
      expect(body.tools[1]).toMatchObject({
        type: 'function',
        name: 'mcp__file_tools__ns__read_file',
      });
      expect(body.tools[2]).toMatchObject({
        type: 'function',
        name: 'mcp__file_tools__ns__write_file',
      });
    });

    it('normalizes custom tools (such as apply_patch) into function format for upstream compatibility', () => {
      const body = {
        model: 'test-model',
        tools: [
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Apply patch to files',
            format: { type: 'grammar', syntax: 'lark', definition: '...' },
          },
        ],
      };
      flattenResponsesRequest(body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].name).toBe('apply_patch');
      expect(body.tools[0].parameters).toBeDefined();
    });

    it('skips unsupported web_search tools without throwing', () => {
      const body = {
        model: 'test-model',
        tools: [
          { type: 'web_search', name: 'search' },
          { type: 'function', name: 'valid_tool', description: 'valid', parameters: {} },
        ],
      };
      flattenResponsesRequest(body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('valid_tool');
    });

    it('rejects empty namespace tool array (fail-closed)', () => {
      const body = {
        tools: [{ type: 'namespace', name: 'empty_ns', tools: [] }],
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/must contain non-empty tools array/);
    });

    it('rejects nested namespace tools (fail-closed)', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'outer',
            tools: [{ type: 'namespace', name: 'inner', tools: [{ type: 'function', name: 'f' }] }],
          },
        ],
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/Nested namespace tools are not supported/);
    });

    it('rejects tool name collisions with existing tools or across namespaces', () => {
      const collidingBody = {
        tools: [
          { type: 'function', name: 'mcp__file_tools__ns__read_file' },
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
      };
      expect(() => flattenResponsesRequest(collidingBody)).toThrow(/contains reserved delimiter|collision/);
    });

    it('rewrites tool_choice referencing namespaced tools', () => {
      const body1 = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        tool_choice: {
          type: 'namespace',
          name: 'mcp__file_tools',
          function: { name: 'read_file' },
        },
      };
      flattenResponsesRequest(body1);
      expect(body1.tool_choice).toEqual({
        type: 'function',
        function: { name: 'mcp__file_tools__ns__read_file' },
      });

      const body2 = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        tool_choice: {
          type: 'function',
          namespace: 'mcp__file_tools',
          name: 'read_file',
        },
      };
      flattenResponsesRequest(body2);
      expect(body2.tool_choice).toEqual({
        type: 'function',
        name: 'mcp__file_tools__ns__read_file',
      });
    });

    it('rejects namespace-wide tool choice without function name', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        tool_choice: {
          type: 'namespace',
          name: 'mcp__file_tools',
        },
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/Namespace-wide tool_choice is unsupported/);
    });

    it('rejects tool_choice referencing unregistered tools', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        tool_choice: {
          type: 'function',
          name: 'unregistered_tool',
        },
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/references unregistered tool/);
    });

    it('rewrites allowed_tools tool_choice form', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        tool_choice: {
          type: 'allowed_tools',
          tools: [
            {
              type: 'function',
              namespace: 'mcp__file_tools',
              name: 'read_file',
            },
          ],
        },
      };
      flattenResponsesRequest(body);
      const choice = body.tool_choice as { type: string; tools: Array<{ name: string }> };
      expect(choice.tools[0]?.name).toBe('mcp__file_tools__ns__read_file');
    });

    it('rejects subtools with unsupported types inside a namespace', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__custom',
            tools: [{ type: 'bash', name: 'run_cmd' }],
          },
        ],
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/unsupported subtool type/);
    });

    it('rejects function tool_choice without function name', () => {
      const body = {
        tools: [
          {
            type: 'function',
            name: 'read_file',
          },
        ],
        tool_choice: {
          type: 'function',
        },
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/Function tool_choice missing function name/);
    });

    it('rejects function tool_choice with conflicting name and function.name', () => {
      const body = {
        tools: [
          {
            type: 'function',
            name: 'read_file',
          },
        ],
        tool_choice: {
          type: 'function',
          name: 'read_file',
          function: { name: 'other_file' },
        },
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/Conflicting tool_choice names/);
    });

    it('rejects allowed_tools containing non-object or unregistered tools', () => {
      const bodyWithNull = {
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: {
          type: 'allowed_tools',
          tools: [null],
        },
      };
      expect(() => flattenResponsesRequest(bodyWithNull)).toThrow(/must be an object/);

      const bodyWithUnregistered = {
        tools: [{ type: 'function', name: 'read_file' }],
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', name: 'nonexistent' }],
        },
      };
      expect(() => flattenResponsesRequest(bodyWithUnregistered)).toThrow(/references unregistered tool/);
    });

    it('rewrites prior function_call conversation history and preserves call_id', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [
              { type: 'function', name: 'read_file' },
              { type: 'function', name: 'write_file' },
            ],
          },
        ],
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            namespace: 'mcp__file_tools',
            arguments: '{}',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'function_call',
                call_id: 'call_2',
                name: 'write_file',
                namespace: 'mcp__file_tools',
                arguments: '{}',
              },
            ],
          },
        ],
      };
      flattenResponsesRequest(body);
      expect(body.input[0]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'mcp__file_tools__ns__read_file',
        arguments: '{}',
      });
      expect(body.input[1].content[0]).toEqual({
        type: 'function_call',
        call_id: 'call_2',
        name: 'mcp__file_tools__ns__write_file',
        arguments: '{}',
      });
    });

    it('rejects conversation history referencing unregistered namespace tools', () => {
      const body = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'unknown_function',
            namespace: 'mcp__other',
            arguments: '{}',
          },
        ],
      };
      expect(() => flattenResponsesRequest(body)).toThrow(/History contains unregistered namespace tool/);
    });

    it('extracts additional_tools from body.input and flattens namespace tools', () => {
      const body = {
        model: 'test-model',
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'function',
                name: 'shell_command',
                description: 'Run shell',
                parameters: { type: 'object' },
              },
              {
                type: 'namespace',
                name: 'mcp__file_tools',
                tools: [
                  {
                    type: 'function',
                    name: 'read_file',
                    description: 'Read file',
                    parameters: { type: 'object' },
                  },
                ],
              },
            ],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      };

      const { nameMapping } = flattenResponsesRequest(body);
      expect(body.input).toHaveLength(1);
      expect(body.input[0].type).toBe('message');
      expect(body.tools).toBeDefined();
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe('shell_command');
      expect(body.tools[1].name).toBe('mcp__file_tools__ns__read_file');
      expect(nameMapping.get('mcp__file_tools__ns__read_file')).toEqual({
        namespace: 'mcp__file_tools',
        originalName: 'read_file',
      });
    });
  });

  describe('unflattenResponseObject and safety checks', () => {
    const mapping = new Map([
      ['mcp__file_tools__ns__read_file', { namespace: 'mcp__file_tools', originalName: 'read_file' }],
    ]);

    it('restores name and namespace in output_item events and completed responses', () => {
      const itemAdded = {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          name: 'mcp__file_tools__ns__read_file',
          call_id: 'c1',
        },
      };
      unflattenResponseObject(itemAdded, mapping);
      expect(itemAdded.item).toEqual({
        type: 'function_call',
        name: 'read_file',
        namespace: 'mcp__file_tools',
        call_id: 'c1',
      });

      const argsDone = {
        type: 'response.function_call_arguments.done',
        name: 'mcp__file_tools__ns__read_file',
        arguments: '{"file_path": "test.txt"}',
      };
      unflattenResponseObject(argsDone, mapping);
      expect(argsDone.name).toBe('read_file');
      const argsDoneTyped = argsDone as { name: string; namespace?: string };
      expect(argsDoneTyped.namespace).toBe('mcp__file_tools');

      const completed = {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'function_call',
              name: 'mcp__file_tools__ns__read_file',
            },
          ],
        },
      };
      unflattenResponseObject(completed, mapping);
      expect(completed.response.output[0]).toEqual({
        type: 'function_call',
        name: 'read_file',
        namespace: 'mcp__file_tools',
      });
    });

    it('fails safely and throws on unrecognized flattened tool identities', () => {
      const unknownItem = {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          name: 'mcp__unknown__ns__bad_func',
        },
      };
      expect(() => unflattenResponseObject(unknownItem, mapping)).toThrow('Unrecognized flattened tool identity');
    });

    it('transforms SSE blocks and passes through [DONE]', () => {
      const block = [
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"mcp__file_tools__ns__read_file"}}',
      ].join('\n');
      const transformed = transformSseBlock(block, mapping);
      expect(transformed).toContain('"name":"read_file"');
      expect(transformed).toContain('"namespace":"mcp__file_tools"');

      const doneBlock = 'data: [DONE]';
      expect(transformSseBlock(doneBlock, mapping)).toBe(doneBlock);
    });
  });

  describe('relayTarget', () => {
    it('rewrites target path correctly while maintaining upstream host and protocol', () => {
      const target = relayTarget('/v1/responses?stream=true', 'https://upstream.local:9000/api');
      expect(target.protocol).toBe('https:');
      expect(target.host).toBe('upstream.local:9000');
      expect(target.pathname).toBe('/v1/responses');
      expect(target.search).toBe('?stream=true');
    });
  });

  describe('HTTP Relay Server end-to-end', () => {
    it('handles golden fixture from installed worker protocol (Codex CLI 0.144.6 wire format)', async () => {
      let upstreamReceivedBody: {
        tools?: Array<{ type: string; name: string; description?: string; parameters?: unknown }>;
      } | null = null;

      const upstreamServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c.toString('utf8')));
        req.on('end', () => {
          upstreamReceivedBody = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
          res.write(
            'event: response.output_item.added\r\ndata: {"type":"response.output_item.added","item":{"type":"function_call","name":"mcp__file_tools__ns__read_file","arguments":""}}\r\n\r\n',
          );
          res.write(
            'event: response.output_item.done\r\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"mcp__file_tools__ns__read_file","arguments":"{\\"file_path\\":\\"SPEC.md\\"}"}}\r\n\r\n',
          );
          res.write('data: [DONE]\r\n\r\n');
          res.end();
        });
      });

      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

      const relay = createRelayServer({
        upstream: upstreamUrl,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const clientReqBody = {
          model: 'glm-5.3-flash',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__file_tools',
              description: 'Filesystem tools',
              tools: [
                {
                  type: 'function',
                  name: 'read_file',
                  description: 'Read file contents',
                  parameters: {
                    type: 'object',
                    properties: { file_path: { type: 'string' } },
                    required: ['file_path'],
                  },
                },
              ],
            },
          ],
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Read SPEC.md' }],
            },
          ],
        };

        const responseText = await new Promise<string>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve(out));
            },
          );
          req.on('error', reject);
          req.write(JSON.stringify(clientReqBody));
          req.end();
        });

        expect(upstreamReceivedBody?.tools?.[0]).toEqual({
          type: 'function',
          name: 'mcp__file_tools__ns__read_file',
          description: 'Read file contents',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        });

        expect(responseText).toContain('"name":"read_file"');
        expect(responseText).toContain('"namespace":"mcp__file_tools"');
        expect(responseText).toContain('data: [DONE]');
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('safely handles compressed upstream responses (gzip and deflate)', async () => {
      const upstreamServer = http.createServer((req, res) => {
        const json = JSON.stringify({
          output: [
            {
              type: 'function_call',
              name: 'mcp__file_tools__ns__read_file',
              arguments: '{}',
            },
          ],
        });
        const compressed = gzipSync(Buffer.from(json, 'utf8'));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
        });
        res.end(compressed);
      });

      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

      const relay = createRelayServer({
        upstream: upstreamUrl,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const clientReqBody = {
          model: 'test-model',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__file_tools',
              tools: [{ type: 'function', name: 'read_file' }],
            },
          ],
        };

        const responseText = await new Promise<string>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve(out));
            },
          );
          req.on('error', reject);
          req.write(JSON.stringify(clientReqBody));
          req.end();
        });

        const parsed = JSON.parse(responseText);
        expect(parsed.output[0]).toEqual({
          type: 'function_call',
          name: 'read_file',
          namespace: 'mcp__file_tools',
          arguments: '{}',
        });
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('safely handles deflate compressed upstream responses', async () => {
      const upstreamServer = http.createServer((req, res) => {
        const json = JSON.stringify({
          output: [
            {
              type: 'function_call',
              name: 'mcp__file_tools__ns__read_file',
              arguments: '{}',
            },
          ],
        });
        const compressed = deflateSync(Buffer.from(json, 'utf8'));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'deflate',
        });
        res.end(compressed);
      });

      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

      const relay = createRelayServer({
        upstream: upstreamUrl,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const clientReqBody = {
          model: 'test-model',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__file_tools',
              tools: [{ type: 'function', name: 'read_file' }],
            },
          ],
        };

        const responseText = await new Promise<string>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve(out));
            },
          );
          req.on('error', reject);
          req.write(JSON.stringify(clientReqBody));
          req.end();
        });

        const parsed = JSON.parse(responseText);
        expect(parsed.output[0]).toEqual({
          type: 'function_call',
          name: 'read_file',
          namespace: 'mcp__file_tools',
          arguments: '{}',
        });
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('cancels upstream inference when client disconnects during active inference', async () => {
      let upstreamAborted = false;

      const upstreamServer = http.createServer((req, res) => {
        req.on('close', () => {
          upstreamAborted = true;
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: progress\r\ndata: {"status":"thinking"}\r\n\r\n');
        // Do not finish immediately to allow client abort test
      });

      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

      const relay = createRelayServer({
        upstream: upstreamUrl,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const req = http.request({
          hostname: '127.0.0.1',
          port: relayPort,
          path: '/v1/responses',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });

        req.write(
          JSON.stringify({
            model: 'test',
            tools: [{ type: 'function', name: 'f' }],
          }),
        );
        req.end();

        // Wait for first response chunk, then destroy client socket
        await new Promise<void>((resolve) => {
          req.on('response', (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          });
        });

        // Give event loop time to propagate cancellation to upstream
        await new Promise((r) => setTimeout(r, 100));
        expect(upstreamAborted).toBe(true);
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('handles request body overflow safely with HTTP 413 without crashing', async () => {
      const upstreamServer = http.createServer();
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

      const relay = createRelayServer({
        upstream: upstreamUrl,
        compatibilityMode: 'flatten_namespaces',
        maxBodyBytes: 1024,
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const statusCode = await new Promise<number>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => resolve(res.statusCode ?? 0),
          );
          req.on('error', () => {
            // Socket might be closed after 413, ignore
          });

          // Send chunk larger than 1024 bytes (2048 bytes)
          const bigChunk = Buffer.alloc(2048, 65);
          req.write(bigChunk);
          req.end();
        });

        expect(statusCode).toBe(413);

        // Verify relay is still alive and accepting subsequent requests
        const pingStatus = await new Promise<number>((resolve) => {
          const pingReq = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => resolve(res.statusCode ?? 0),
          );
          pingReq.write('{ not valid json');
          pingReq.end();
        });
        expect(pingStatus).toBe(400);
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('returns generic error without leaking upstream stack traces when upstream fails', async () => {
      // Connect to non-existent upstream port
      const relay = createRelayServer({
        upstream: 'http://127.0.0.1:59999',
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
            },
          );
          req.write(JSON.stringify({ model: 'test', tools: [{ type: 'function', name: 'f' }] }));
          req.end();
        });

        expect(status).toBe(502);
        const parsed = JSON.parse(body);
        expect(parsed.error.message).toBe('Upstream model service error');
        expect(body).not.toContain('ECONNREFUSED');
      } finally {
        relay.close();
      }
    });

    it('handles malformed upstream compressed responses cleanly with HTTP 502 without process exit', async () => {
      const upstreamServer = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          });
          res.end('invalid-gzip-payload');
        });
      });
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;
      const relay = createRelayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
            },
          );
          req.write(JSON.stringify({ tools: [{ type: 'function', name: 'read' }] }));
          req.end();
        });

        expect(status).toBe(502);
        const parsed = JSON.parse(body);
        expect(parsed.error.message).toBe('Upstream model service error');
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('returns HTTP 400 on malformed inbound URL and survives for subsequent requests', async () => {
      const upstreamServer = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;

      const relay = createRelayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const net = await import('node:net');
        const rawResponse = await new Promise<string>((resolve) => {
          const socket = net.connect(relayPort, '127.0.0.1', () => {
            socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
          });
          let data = '';
          socket.on('data', (c) => (data += c.toString('utf8')));
          socket.on('end', () => resolve(data));
          socket.on('error', () => resolve(data));
        });

        expect(rawResponse).toContain('400 Bad Request');
        expect(rawResponse).toContain('invalid_url');

        // Verify relay process is alive and responds to normal requests
        const pingStatus = await new Promise<number>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/health',
              method: 'GET',
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            },
          );
          req.on('error', () => resolve(0));
          req.end();
        });
        expect(pingStatus).toBe(200);
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('fails closed with HTTP 502 on unrecognized tool alias in JSON response', async () => {
      const upstreamServer = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              output: [
                {
                  type: 'function_call',
                  name: 'unknown__ns__tool',
                  call_id: 'probe',
                  arguments: '{}',
                },
              ],
            }),
          );
        });
      });
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;

      const relay = createRelayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        compatibilityMode: 'flatten_namespaces',
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
            },
          );
          req.write(
            JSON.stringify({
              tools: [
                {
                  type: 'namespace',
                  name: 'ns',
                  tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
                },
              ],
            }),
          );
          req.end();
        });

        expect(status).toBe(502);
        const parsed = JSON.parse(body);
        expect(parsed.error.code).toBe('upstream_error');
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('handles compressed SSE streams with backpressure correctly, pausing upstream and resuming on drain', async () => {
      const frameCount = 100;
      let rawSse = '';
      for (let i = 0; i < frameCount; i++) {
        const padding = randomBytes(700).toString('hex');
        rawSse += `event: response.output_item.added\r\ndata: {"type":"response.output_item.added","index":${i},"item":{"type":"function_call","name":"ns__ns__read","arguments":"{\\"pad\\":\\"${padding}\\"}"}}\r\n\r\n`;
      }
      rawSse += 'data: [DONE]\r\n\r\n';

      const compressed = gzipSync(Buffer.from(rawSse, 'utf8'));
      expect(compressed.byteLength).toBeGreaterThan(64 * 1024);

      const upstreamServer = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'content-encoding': 'gzip',
          });
          const chunkSize = 16384;
          for (let offset = 0; offset < compressed.length; offset += chunkSize) {
            res.write(compressed.subarray(offset, offset + chunkSize));
          }
          res.end();
        });
      });
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;

      const relay = createRelayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        compatibilityMode: 'flatten_namespaces',
      });

      let writeFalseCount = 0;
      let drainTriggered = false;
      let endCalls = 0;
      let writesWhilePaused = 0;

      relay.prependListener('request', (_req, res) => {
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        res.write = ((chunk: unknown, ...args: unknown[]) => {
          if (writeFalseCount < 2) {
            writeFalseCount++;
            (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
            setTimeout(() => {
              drainTriggered = true;
              res.emit('drain');
            }, 60);
            return false;
          }

          if (!drainTriggered && writeFalseCount > 0) {
            writesWhilePaused++;
          }

          return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
        }) as typeof res.write;

        res.end = ((...args: unknown[]) => {
          endCalls++;
          return (origEnd as (...a: unknown[]) => http.ServerResponse)(...args);
        }) as typeof res.end;
      });

      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      try {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: relayPort,
              path: '/v1/responses',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            (res) => {
              let out = '';
              res.on('data', (c) => (out += c.toString('utf8')));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
            },
          );
          req.on('error', reject);
          req.write(
            JSON.stringify({
              tools: [
                {
                  type: 'namespace',
                  name: 'ns',
                  tools: [{ type: 'function', name: 'read' }],
                },
              ],
            }),
          );
          req.end();
        });

        expect(status).toBe(200);
        expect(writeFalseCount).toBeGreaterThanOrEqual(1);
        expect(drainTriggered).toBe(true);
        expect(writesWhilePaused).toBe(0);
        expect(endCalls).toBe(1);

        for (let i = 0; i < frameCount; i++) {
          const needle = `"index":${i}`;
          const pos = body.indexOf(needle);
          expect(pos).toBeGreaterThan(-1);
          if (i > 0) {
            const prevNeedle = `"index":${i - 1}`;
            const prevPos = body.indexOf(prevNeedle);
            expect(pos).toBeGreaterThan(prevPos);
          }
        }

        expect(body).toContain('"name":"read"');
        expect(body).toContain('"namespace":"ns"');
        expect(body).not.toContain('ns__ns__read');
        expect(body).toContain('data: [DONE]');
      } finally {
        relay.close();
        upstreamServer.close();
      }
    });

    it('enforces deterministic overload admission limit with HTTP 503 too_many_requests', async () => {
      const upstreamResMap = new Map<string, http.ServerResponse>();

      const upstreamServer = http.createServer((req, res) => {
        const id = String(req.headers['x-request-id'] ?? '');
        if (id) {
          upstreamResMap.set(id, res);
        }
        req.resume();
      });
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
      const upstreamPort = (upstreamServer.address() as AddressInfo).port;

      const maxConcurrent = 2;
      const relay = createRelayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        compatibilityMode: 'flatten_namespaces',
        maxConcurrent,
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      const relayPort = (relay.address() as AddressInfo).port;

      const activeClientReqs: http.ClientRequest[] = [];

      try {
        const sendRequest = (requestId: string) => {
          return new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request(
              {
                hostname: '127.0.0.1',
                port: relayPort,
                path: '/v1/responses',
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-request-id': requestId,
                  connection: 'close',
                },
              },
              (res) => {
                let out = '';
                res.on('data', (c) => (out += c.toString('utf8')));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
              },
            );
            req.on('error', reject);
            activeClientReqs.push(req);
            req.write(JSON.stringify({ tools: [{ type: 'function', name: 'read' }] }));
            req.end();
          });
        };

        const waitForUpstream = async (requestId: string, maxMs = 2000) => {
          const start = Date.now();
          while (!upstreamResMap.has(requestId)) {
            if (Date.now() - start > maxMs) {
              throw new Error(`Timed out waiting for upstream request ${requestId}`);
            }
            await new Promise((r) => setTimeout(r, 10));
          }
        };

        // 1. Start req-1 and await its confirmed arrival at upstream
        const p1 = sendRequest('req-1');
        await waitForUpstream('req-1');

        // 2. Start req-2 and await its confirmed arrival at upstream
        const p2 = sendRequest('req-2');
        await waitForUpstream('req-2');

        // 3. Both slots (2/2) are held. Third request must immediately receive 503 too_many_requests
        const rejected = await sendRequest('req-3');
        expect(rejected.status).toBe(503);
        const rejectedBody = JSON.parse(rejected.body);
        expect(rejectedBody.error.code).toBe('too_many_requests');
        expect(rejectedBody.error.message).toBe('Server busy');

        // 4. Complete req-1 upstream response, releasing 1 capacity slot
        const res1Upstream = upstreamResMap.get('req-1')!;
        upstreamResMap.delete('req-1');
        res1Upstream.writeHead(200, { 'content-type': 'application/json' });
        res1Upstream.end(JSON.stringify({ output: [] }));

        const res1 = await p1;
        expect(res1.status).toBe(200);

        // 5. Send req-4: it should now be admitted into the freed slot
        const p4 = sendRequest('req-4');
        await waitForUpstream('req-4');

        // 6. Complete remaining in-flight upstream responses (req-2 and req-4)
        for (const [id, res] of upstreamResMap.entries()) {
          upstreamResMap.delete(id);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ output: [] }));
        }

        const [res2, res4] = await Promise.all([p2, p4]);
        expect(res2.status).toBe(200);
        expect(res4.status).toBe(200);
      } finally {
        for (const res of upstreamResMap.values()) {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        }
        for (const req of activeClientReqs) {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        }
        relay.close();
        upstreamServer.close();
      }
    });
  });

  describe('genuine MCP aliases and transactional historyRegistry regressions', () => {
    it('getGenuineMcpAlias restricts aliases strictly to trusted MCP servers', () => {
      // Default trusted set includes 'file_tools'
      expect(getGenuineMcpAlias('file_tools')).toBe('mcp__file_tools');
      expect(getGenuineMcpAlias('mcp__file_tools')).toBe('file_tools');

      // Built-in disguise: 'functions' or 'mcp__functions' must NOT be authorized
      expect(getGenuineMcpAlias('functions')).toBeNull();
      expect(getGenuineMcpAlias('mcp__functions')).toBeNull();

      // Arbitrary namespace: 'foo' or 'mcp__foo' must NOT be authorized
      expect(getGenuineMcpAlias('foo')).toBeNull();
      expect(getGenuineMcpAlias('mcp__foo')).toBeNull();

      // Unrelated prefix: 'custom__file_tools' must NOT be authorized
      expect(getGenuineMcpAlias('custom__file_tools')).toBeNull();

      // Custom trustedMcpServers parameter
      const customTrusted = ['custom_server'];
      expect(getGenuineMcpAlias('custom_server', customTrusted)).toBe('mcp__custom_server');
      expect(getGenuineMcpAlias('mcp__custom_server', customTrusted)).toBe('custom_server');
      expect(getGenuineMcpAlias('file_tools', customTrusted)).toBeNull();
    });

    it('resolves genuine MCP aliases bidirectional (mcp__file_tools <-> file_tools) in tools, history, and tool_choice', () => {
      // Case 1: Declared with mcp__file_tools, referenced in history and tool_choice via alias file_tools
      const body1 = {
        model: 'test-model',
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
          },
        ],
        tool_choice: {
          type: 'namespace',
          name: 'file_tools',
          function: { name: 'read_file' },
        },
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            namespace: 'file_tools',
            name: 'read_file',
            arguments: '{}',
          },
        ],
      };

      const { nameMapping: map1 } = flattenResponsesRequest(body1);
      expect(map1.size).toBe(1);
      expect(map1.has('mcp__file_tools__ns__read_file')).toBe(true);
      expect(body1.tools[0].name).toBe('mcp__file_tools__ns__read_file');
      expect(body1.tool_choice).toEqual({
        type: 'function',
        function: { name: 'mcp__file_tools__ns__read_file' },
      });
      expect(body1.input[0]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'mcp__file_tools__ns__read_file',
        arguments: '{}',
      });

      // Case 2: Declared with file_tools, referenced in history and tool_choice via alias mcp__file_tools
      const body2 = {
        model: 'test-model',
        tools: [
          {
            type: 'namespace',
            name: 'file_tools',
            tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
          },
        ],
        tool_choice: {
          type: 'function',
          namespace: 'mcp__file_tools',
          name: 'read_file',
        },
        input: [
          {
            type: 'function_call',
            call_id: 'call_2',
            namespace: 'mcp__file_tools',
            name: 'read_file',
            arguments: '{}',
          },
        ],
      };

      const { nameMapping: map2 } = flattenResponsesRequest(body2);
      expect(map2.size).toBe(1);
      expect(map2.has('file_tools__ns__read_file')).toBe(true);
      expect(body2.tools[0].name).toBe('file_tools__ns__read_file');
      expect(body2.tool_choice).toEqual({
        type: 'function',
        name: 'file_tools__ns__read_file',
      });
      expect(body2.input[0]).toEqual({
        type: 'function_call',
        call_id: 'call_2',
        name: 'file_tools__ns__read_file',
        arguments: '{}',
      });
    });

    it('rejects alias collisions with existing tools or aliases (TOOL_COLLISION)', () => {
      // Co-declaring both mcp__file_tools and file_tools in the same request collides
      const bodyCollision = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
          {
            type: 'namespace',
            name: 'file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
      };
      expect(() => flattenResponsesRequest(bodyCollision)).toThrowError(
        expect.objectContaining({ code: 'TOOL_COLLISION' }),
      );

      // Incompatible redefinition against historical registry collides
      const historyRegistry = new Map();
      const bodyInitial = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
      };
      flattenResponsesRequest(bodyInitial, { historyRegistry });

      // A request defining a tool that collides with an incompatible historical entry throws
      const conflictingRegistry = new Map();
      conflictingRegistry.set('mcp__file_tools__ns__read_file', {
        namespace: 'conflicting_ns',
        originalName: 'read_file',
        canonicalFlattenedName: 'mcp__file_tools__ns__read_file',
      });
      const bodyWithConflictingTool = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file' }],
          },
        ],
      };
      expect(() =>
        flattenResponsesRequest(bodyWithConflictingTool, { historyRegistry: conflictingRegistry }),
      ).toThrowError(
        expect.objectContaining({
          code: 'TOOL_COLLISION',
          message: expect.stringContaining(
            'Tool collision with previously registered tool: mcp__file_tools__ns__read_file',
          ),
        }),
      );

      // Same tool identity is valid (idempotent re-declaration)
      const bodyExactSame = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file', description: 'different' }],
          },
        ],
      };
      expect(() => flattenResponsesRequest(bodyExactSame, { historyRegistry })).not.toThrow();
    });

    it('handles context compaction transition: Request 1 registers tools, Request 2 with tools: [] rewrites history but rejects tool_choice and response invocation', () => {
      const historyRegistry = new Map();

      // Request 1: Active turn declaring tools
      const req1 = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
          },
        ],
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            namespace: 'mcp__file_tools',
            name: 'read_file',
            arguments: '{}',
          },
        ],
      };
      const { nameMapping: map1 } = flattenResponsesRequest(req1, { historyRegistry });
      expect(map1.size).toBe(1);
      expect(historyRegistry.has('mcp__file_tools__ns__read_file')).toBe(true);

      // Request 2: Codex contextCompaction turn where tools array is empty
      const req2Compaction = {
        tools: [],
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            namespace: 'mcp__file_tools',
            name: 'read_file',
            arguments: '{}',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'function_call',
                call_id: 'call_2',
                namespace: 'file_tools', // alias reference from compaction history
                name: 'read_file',
                arguments: '{}',
              },
            ],
          },
        ],
      };

      const { nameMapping: map2 } = flattenResponsesRequest(req2Compaction, { historyRegistry });

      // Request 2 successfully rewrote historical calls
      expect(req2Compaction.input[0].name).toBe('mcp__file_tools__ns__read_file');
      expect(req2Compaction.input[0].namespace).toBeUndefined();
      expect(req2Compaction.input[1].content[0].name).toBe('mcp__file_tools__ns__read_file');
      expect(req2Compaction.input[1].content[0].namespace).toBeUndefined();

      // But Request 2 local mapping is strictly empty (tools were not declared)
      expect(map2.size).toBe(0);

      // If Request 2 attempts tool_choice referencing the former tool, it is strictly rejected
      const req2WithToolChoice = {
        tools: [],
        tool_choice: {
          type: 'function',
          name: 'mcp__file_tools__ns__read_file',
        },
      };
      expect(() => flattenResponsesRequest(req2WithToolChoice, { historyRegistry })).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      // And unflattenResponseObject for Request 2 strictly rejects model invoking the former tool
      expect(() =>
        unflattenResponseObject({ type: 'function_call', name: 'mcp__file_tools__ns__read_file' }, map2),
      ).toThrowError(expect.objectContaining({ code: 'UNRECOGNIZED_TOOL_IDENTITY' }));
    });

    it('fails closed on unaliased/unregistered tools and malformed names in history', () => {
      // Unregistered namespace
      const reqUnregistered = {
        tools: [],
        input: [{ type: 'function_call', namespace: 'unregistered_ns', name: 'read_file' }],
      };
      expect(() => flattenResponsesRequest(reqUnregistered)).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_HISTORY_TOOL' }),
      );

      // Built-in disguise without registration
      const reqBuiltinDisguise = {
        tools: [],
        input: [{ type: 'function_call', namespace: 'functions', name: 'read_file' }],
      };
      expect(() => flattenResponsesRequest(reqBuiltinDisguise)).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_HISTORY_TOOL' }),
      );

      // Malformed namespace with reserved delimiter
      const reqMalformedNs = {
        tools: [],
        input: [{ type: 'function_call', namespace: 'bad__ns__name', name: 'read_file' }],
      };
      expect(() => flattenResponsesRequest(reqMalformedNs)).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_HISTORY_TOOL' }),
      );

      // Malformed tool name with reserved delimiter
      const reqMalformedToolName = {
        tools: [],
        input: [{ type: 'function_call', namespace: 'mcp__file_tools', name: 'sub__ns__tool' }],
      };
      expect(() => flattenResponsesRequest(reqMalformedToolName)).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_HISTORY_TOOL' }),
      );

      // Unregistered already-flattened tool name in history
      const reqFlattenedUnregistered = {
        tools: [],
        input: [{ type: 'function_call', name: 'unknown__ns__read_file' }],
      };
      expect(() => flattenResponsesRequest(reqFlattenedUnregistered)).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_HISTORY_TOOL' }),
      );
    });

    it('enforces transactional rollback: historyRegistry is not mutated if request validation fails', () => {
      const historyRegistry = new Map();

      // Request declares a valid new tool, but contains an invalid tool_choice
      const reqInvalid = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'new_tool', parameters: { type: 'object' } }],
          },
        ],
        tool_choice: {
          type: 'function',
          name: 'nonexistent_tool',
        },
      };

      expect(() => flattenResponsesRequest(reqInvalid, { historyRegistry })).toThrow();

      // Assert historyRegistry remains completely clean and unpolluted
      expect(historyRegistry.size).toBe(0);
      expect(historyRegistry.has('mcp__file_tools__ns__new_tool')).toBe(false);
      expect(historyRegistry.has('file_tools__ns__new_tool')).toBe(false);
    });

    it('bounds historyRegistry entries to MAX_HISTORY_REGISTRY_ENTRIES (256) with LRU eviction', () => {
      const historyRegistry = new Map();
      expect(MAX_HISTORY_REGISTRY_ENTRIES).toBe(256);

      // Pre-populate registry with 256 dummy entries
      for (let i = 0; i < 256; i++) {
        historyRegistry.set(`old_tool_${i}__ns__action`, {
          namespace: `old_tool_${i}`,
          originalName: 'action',
          canonicalFlattenedName: `old_tool_${i}__ns__action`,
        });
      }
      expect(historyRegistry.size).toBe(256);

      // Now process a request with a new tool
      const reqNew = {
        tools: [
          {
            type: 'namespace',
            name: 'mcp__file_tools',
            tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
          },
        ],
      };

      flattenResponsesRequest(reqNew, { historyRegistry });

      // Registry size must NOT exceed 256
      expect(historyRegistry.size).toBeLessThanOrEqual(256);
      expect(historyRegistry.has('mcp__file_tools__ns__read_file')).toBe(true);
      // Oldest entry was evicted
      expect(historyRegistry.has('old_tool_0__ns__action')).toBe(false);
    });

    it('rejects extra delimiter segments, empty components, non-strings, and untrusted prefixes in tool_choice', () => {
      const validTools = [
        {
          type: 'namespace',
          name: 'mcp__file_tools',
          tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        },
      ];

      // 1. Extra delimiter segments
      const reqExtraDelimiter = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          name: 'mcp__file_tools__ns__read_file__ns__extra',
        },
      };
      expect(() => flattenResponsesRequest(reqExtraDelimiter)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      // 2. Empty component
      const reqEmptyComponent = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          name: 'mcp__file_tools__ns__',
        },
      };
      expect(() => flattenResponsesRequest(reqEmptyComponent)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      const reqEmptyPrefix = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          name: '__ns__read_file',
        },
      };
      expect(() => flattenResponsesRequest(reqEmptyPrefix)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      // 3. Non-string function name
      const reqNonStringName = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          name: 12345,
        },
      };
      expect(() => flattenResponsesRequest(reqNonStringName)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE' }),
      );

      // 4. Non-string namespace
      const reqNonStringNs = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          namespace: 12345,
          name: 'read_file',
        },
      };
      expect(() => flattenResponsesRequest(reqNonStringNs)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE' }),
      );

      // 5. Untrusted / builtin prefix disguise
      const reqUntrustedPrefix = {
        tools: validTools,
        tool_choice: {
          type: 'function',
          name: 'functions__ns__read_file',
        },
      };
      expect(() => flattenResponsesRequest(reqUntrustedPrefix)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );
    });

    it('rejects extra delimiter segments, empty components, non-strings, and untrusted prefixes in allowed_tools', () => {
      const validTools = [
        {
          type: 'namespace',
          name: 'mcp__file_tools',
          tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        },
      ];

      // 1. Extra delimiter segments
      const reqExtraDelimiter = {
        tools: validTools,
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', name: 'mcp__file_tools__ns__read_file__ns__extra' }],
        },
      };
      expect(() => flattenResponsesRequest(reqExtraDelimiter)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      // 2. Empty component
      const reqEmptyComponent = {
        tools: validTools,
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', name: 'mcp__file_tools__ns__' }],
        },
      };
      expect(() => flattenResponsesRequest(reqEmptyComponent)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );

      // 3. Non-string function name
      const reqNonStringName = {
        tools: validTools,
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', name: 123 }],
        },
      };
      expect(() => flattenResponsesRequest(reqNonStringName)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE' }),
      );

      // 4. Non-string namespace
      const reqNonStringNs = {
        tools: validTools,
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', namespace: 123, name: 'read_file' }],
        },
      };
      expect(() => flattenResponsesRequest(reqNonStringNs)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE' }),
      );

      // 5. Untrusted / builtin prefix disguise
      const reqUntrustedPrefix = {
        tools: validTools,
        tool_choice: {
          type: 'allowed_tools',
          tools: [{ type: 'function', name: 'functions__ns__read_file' }],
        },
      };
      expect(() => flattenResponsesRequest(reqUntrustedPrefix)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOOL_CHOICE_UNREGISTERED_TOOL' }),
      );
    });
  });
});
