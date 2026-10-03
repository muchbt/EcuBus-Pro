import EventEmitter from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ callback: null as any, sent: null as any }))
vi.mock('../../src/main/vsomeip/build/Release/vsomeip.node', () => ({
  default: {
    LoadDll: vi.fn(),
    runtime: { get: () => ({ create_application: () => ({ init: () => true }) }) },
    SomeipMessage: class {},
    VsomeipCallbackWrapper: class {
      registerTraceHandler() {}
      registerStateHandler() {}
      registerMessageHandler() {}
      registerAvailabilityHandler() {}
      start() {}
    },
    RegisterCallback: (_type: string, _name: string, callback: any) => {
      native.callback = callback
      return 'callback'
    },
    Send: class {
      sendMessage(message: any, payload: Buffer) {
        // Emulate the mutable argument populated from the post-send native header.
        message.client = 0x6301
        message.session = 7
        message.protocolVersion = 1
        message.interfaceVersion = 2
        native.sent = { ...message, payload }
      }
    }
  }
}))
vi.mock('../../resources/lib/vsomeip3.dll?asset&asarUnpack', () => ({ default: 'vsomeip3.dll' }))
vi.mock('../../src/main/log', () => ({
  SomeipLOG: class {
    constructor(
      _vendor: string,
      _name: string,
      _id: string,
      private events: EventEmitter
    ) {}
    someipMessage(message: any) {
      this.events.emit('someip-frame', message)
    }
  }
}))
const forks = vi.hoisted(() => ({ children: [] as any[] }))
vi.mock('child_process', () => ({
  fork: () => {
    const child = new EventEmitter() as any
    child.send = vi.fn()
    child.kill = vi.fn()
    forks.children.push(child)
    return child
  },
  spawn: vi.fn(),
  exec: vi.fn()
}))

import NativeClient from '../../src/main/vsomeip/client'
import { VSomeIP_Client } from '../../src/main/vsomeip'

const request = () => ({
  service: 12,
  instance: 1,
  method: 26,
  client: 0,
  session: 0,
  messageType: 0,
  returnCode: 0,
  protocolVersion: 1,
  interfaceVersion: 2,
  payload: Buffer.from([1, 2]),
  ts: 0,
  sending: true
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('outbound request echo', () => {
  it('uses the native post-send identity instead of the unassigned input header', () => {
    const client = new NativeClient('client', 'config.json', vi.fn())
    const input = request()
    const echo = client.sendMessage(input)
    expect(echo).toMatchObject({
      client: 0x6301,
      session: 7,
      protocolVersion: 1,
      interfaceVersion: 2,
      sending: true,
      messageType: 0
    })
    expect(echo.payload).toEqual(input.payload)
    expect(input.client).toBe(0)
    expect(input.session).toBe(0)
  })

  it('publishes exactly one echo before the worker acknowledgement and queued response', async () => {
    const originalSend = process.send
    const messages: any[] = []
    process.send = ((message: any) => {
      messages.push(message)
      return true
    }) as any
    const before = process.listeners('message')
    try {
      await import('../../src/main/vsomeip/worker')
      const handler = process.listeners('message').find((entry) => !before.includes(entry))!
      handler(
        { id: 0, method: 'init', data: { name: 'client', configFilePath: 'config.json' } },
        undefined
      )
      messages.length = 0
      handler({ id: 1, method: 'sendRequest', data: { msg: request() } }, undefined)
      native.callback({
        type: 'message',
        data: { ...native.sent, sending: false, messageType: 128 }
      })
      expect(messages.map((entry) => entry.event?.data.messageType ?? 'ack')).toEqual([
        0,
        'ack',
        128
      ])
      expect(messages[0].event.data).toMatchObject({ sending: true, client: 0x6301, session: 7 })
      expect(messages[2].event.data).toMatchObject({ sending: false, client: 0x6301, session: 7 })
    } finally {
      for (const listener of process.listeners('message'))
        if (!before.includes(listener)) process.off('message', listener)
      process.send = originalSend
    }
  })

  it('forwards echo to frame consumers and rejects wrong client/session until the matching response', async () => {
    global.startTs = 0
    const client = new VSomeIP_Client('client', 'config.json', {
      id: 'device',
      application: { id: '0x6301' }
    } as any)
    const child = forks.children.at(-1)
    const frames: any[] = []
    client.attachSomeipMessage((frame) => frames.push(frame))
    let resolved = false
    const pending = client.sendRequestAndWaitResponse(request(), 1000).then((value) => {
      resolved = true
      return value
    })
    const echo = { ...request(), client: 0x6301, session: 7 }
    child.emit('message', { event: { type: 'message', data: echo } })
    child.emit('message', {
      event: { type: 'message', data: { ...echo, sending: false, messageType: 128, session: 8 } }
    })
    child.emit('message', {
      event: {
        type: 'message',
        data: { ...echo, sending: false, messageType: 128, client: 0x6302 }
      }
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    const response = { ...echo, sending: false, messageType: 128, payload: Buffer.from([3]) }
    child.emit('message', { event: { type: 'message', data: response } })
    expect(await pending).toEqual(response)
    expect(frames.filter((frame) => frame.sending)).toEqual([echo])
  })
})
