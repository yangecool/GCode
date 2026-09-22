/** G Code — 序列化批次测试。运行：pnpm test（node --test）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  historyHasImages,
  serializeGrokMessages,
  serializeGrokTools,
} from '../../src/model/grok/grok-serialize.ts'

const ROUTE = { providerId: 'xai', modelId: 'grok-4.6' }

test('full history round-trip: system/user/assistant(replay)/tool', () => {
  const items = serializeGrokMessages([
    { role: 'system', content: 'You are G Code.' },
    { role: 'user', content: 'read a.ts' },
    {
      role: 'assistant',
      providerId: 'xai',
      modelId: 'grok-4.6',
      content: [
        {
          type: 'reasoning',
          text: 'thinking...',
          providerOptions: {
            grokItem: {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'QUJD',
              summary: [],
              status: 'completed',
            },
          },
        },
        { type: 'text', text: 'Reading now' },
      ],
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
    },
    { role: 'tool', toolCallId: 'call_1', toolName: 'read_file', content: 'file body' },
  ], ROUTE)
  assert.deepEqual(items, [
    { type: 'message', role: 'system', content: 'You are G Code.' },
    { type: 'message', role: 'user', content: 'read a.ts' },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'QUJD', summary: [] },
    { type: 'message', role: 'assistant', content: 'Reading now' },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
  ])
})

test('foreign provider state is ignored and reasoning is synthesized', () => {
  const items = serializeGrokMessages([
    {
      role: 'assistant',
      providerId: 'other',
      modelId: 'grok-4.6',
      content: [
        {
          type: 'reasoning',
          text: 'alien thoughts',
          providerOptions: { grokItem: { type: 'reasoning', status: 'done' } },
        },
      ],
    },
  ], ROUTE)
  assert.deepEqual(items, [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'alien thoughts' }] },
  ])
  const plain = serializeGrokMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
  ], ROUTE)
  assert.deepEqual(plain, [{ type: 'reasoning', summary: [] }])
})

test('hosted text block replays its raw item with status stripped', () => {
  const items = serializeGrokMessages([
    {
      role: 'assistant',
      providerId: 'xai',
      modelId: 'grok-4.6',
      content: [
        {
          type: 'text',
          text: '[backend web_search]',
          providerOptions: {
            grokHostedItem: { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          },
        },
      ],
    },
  ], ROUTE)
  assert.deepEqual(items, [{ type: 'web_search_call', id: 'ws_1' }])
})

test('image user content becomes native input parts', () => {
  const items = serializeGrokMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,QUJD', detail: 'high' },
        { type: 'file', mediaType: 'text/csv', name: 'data.csv', text: 'a,b' },
      ],
    },
  ], ROUTE)
  assert.deepEqual(items, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,QUJD' },
      { type: 'input_text', text: 'a,b' },
    ],
  }])
  assert.equal(historyHasImages([{ role: 'user', content: 'plain' }]), false)
  assert.equal(historyHasImages([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', dataUrl: 'x' }] }]), true)
})

test('tool output and arguments edge cases', () => {
  const items = serializeGrokMessages([
    { role: 'assistant', toolCalls: [{ id: 'c1', name: 't', input: 'not-json' }] },
    { role: 'assistant', toolCalls: [{ id: 'c2', name: 't', input: '{"ok":1}' }] },
    { role: 'tool', toolCallId: 'c1', content: '' },
  ], ROUTE)
  assert.deepEqual(items, [
    // 原版语义：回放的非法 JSON 参数串压成 '{}'（validArguments）。
    { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
    { type: 'function_call', call_id: 'c2', name: 't', arguments: '{"ok":1}' },
    { type: 'function_call_output', call_id: 'c1', output: '(no output)' },
  ])
})

test('invalid replay metadata fails loud', () => {
  assert.throws(
    () => serializeGrokMessages([{
      role: 'assistant',
      providerId: 'xai',
      modelId: 'grok-4.6',
      content: [{ type: 'reasoning', text: '', providerOptions: { grokItem: { type: 'message' } } }],
    }], ROUTE),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_REPLAY_STATE',
  )
})

test('tool serialization drops function names colliding with hosted tools', () => {
  const tools = serializeGrokTools(
    [
      { name: 'read_file', parameters: { type: 'object' } },
      { name: 'web_search', parameters: { type: 'object' } },
    ],
    [{ wireName: 'web_search' }],
  )
  assert.deepEqual(tools, [
    { type: 'function', name: 'read_file', parameters: { type: 'object' } },
    { type: 'web_search' },
  ])
  assert.equal(serializeGrokTools([], []), undefined)
})
