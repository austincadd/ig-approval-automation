#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';

let buf = Buffer.alloc(0);

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  stdout.write(Buffer.concat([header, body]));
}

async function handle(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-mcp-server', version: '0.0.1' }
      }
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'ipify',
            description: 'Fetch public IP from api.ipify.org',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ]
      }
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = params?.name;
    if (tool !== 'ipify') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${tool}` } });
      return;
    }

    try {
      const res = await fetch('https://api.ipify.org?format=json');
      const text = await res.text();
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: text }],
          isError: !res.ok
        }
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `fetch_error: ${err?.message || String(err)}` }],
          isError: true
        }
      });
    }
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;

    const header = buf.slice(0, sep).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      stderr.write('Missing Content-Length header\n');
      buf = Buffer.alloc(0);
      break;
    }

    const len = Number(m[1]);
    const start = sep + 4;
    const end = start + len;
    if (buf.length < end) break;

    const body = buf.slice(start, end).toString('utf8');
    buf = buf.slice(end);

    try {
      const req = JSON.parse(body);
      Promise.resolve(handle(req)).catch((e) => {
        stderr.write(`handle_error: ${e?.message || String(e)}\n`);
      });
    } catch (e) {
      stderr.write(`parse_error: ${e?.message || String(e)}\n`);
    }
  }
});
