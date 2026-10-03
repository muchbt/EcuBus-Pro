// main/worker.ts

import { SomeipMessage, SomeipMessageType } from '../share/someip'
import client from './client'

let instance: client | null = null

function r42SomeipFields(msg: SomeipMessage): string {
  const payload = Buffer.isBuffer(msg.payload) ? msg.payload : Buffer.from(msg.payload as any)
  return `mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${msg.service} instance=${msg.instance} method=${msg.method} client=${msg.client} session=${msg.session} type=${msg.messageType} return=${msg.returnCode} payload_len=${payload.length}`
}

process.on('message', (message: any) => {
  const id = message.id
  const method = message.method
  const data = message.data
  const response: {
    id: number
    data: any
  } = {
    id,
    data: undefined
  }

  switch (method) {
    case 'init': {
      response.data = 'init'
      instance = new client(data.name, data.configFilePath, (val) => {
        process.send!({
          event: val
        })
      })
      instance.init()
      instance.start()

      break
    }
    case 'initRouter': {
      response.data = 'initRouter'
      instance = new client(
        'routingmanagerd',
        data.configFilePath,
        (val) => {
          process.send!({
            event: val
          })
        },
        { router: true }
      )
      instance.init()
      instance.start()

      break
    }
    case 'stop': {
      console.error(
        `[DEBUG-geea-someip-r42-worker-stop-before] mono_us=${(process.hrtime.bigint() / 1000n).toString()} instance=${instance !== null}`
      )
      instance?.stop()
      instance = null
      console.error(
        `[DEBUG-geea-someip-r42-worker-stop-after] mono_us=${(process.hrtime.bigint() / 1000n).toString()} instance=${instance !== null}`
      )
      break
    }
    case 'requestService': {
      instance?.app.request_service(
        Number(data.service),
        Number(data.instance),
        data.major ? Number(data.major) : 0,
        data.minor ? Number(data.minor) : 0
      )
      break
    }
    case 'sendRequest': {
      const fields = r42SomeipFields(data.msg)
      console.error(
        `[DEBUG-geea-someip-r42-worker-native-before] ${fields} instance=${instance !== null}`
      )
      if (!instance) throw new Error('SomeIP is not initialized')
      const sent = instance.sendMessage(data.msg)
      // Publish the stack-assigned header before the acknowledgement and any
      // queued inbound callbacks, preserving frame order on the IPC channel.
      process.send!({ event: { type: 'message', data: sent } })
      console.error(
        `[DEBUG-geea-someip-r42-worker-native-after] ${fields} instance=${instance !== null}`
      )
      break
    }
    case 'notifyEvent': {
      const pl = data.payload
      const buf = Buffer.isBuffer(pl) ? pl : Buffer.from((pl as any)?.data ?? pl ?? [])
      // SWIG: 4 args (…, buf) or 5 args (…, buf, force); char*+length come from one Buffer via vsomeip.i typemap
      const fields = `mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${Number(data.service)} instance=${Number(data.instance)} event=${Number(data.event)} payload_len=${buf.length}`
      console.error(
        `[DEBUG-geea-someip-r48-notify-native-before] ${fields} instance=${instance !== null}`
      )
      instance?.sendc.notify_event(
        Number(data.service),
        Number(data.instance),
        Number(data.event),
        buf,
        Boolean(data.force)
      )
      console.error(
        `[DEBUG-geea-someip-r48-notify-native-after] ${fields} instance=${instance !== null}`
      )
      break
    }
    case 'startPeriodicMessage': {
      const pl = data.payload
      const buf = Buffer.isBuffer(pl) ? pl : Buffer.from((pl as any)?.data ?? pl ?? [])
      instance?.startPeriodicMessage(
        String(data.taskId),
        data.msg,
        buf,
        Number(data.periodMs),
        Boolean(data.asNotify),
        Boolean(data.force)
      )
      break
    }
    case 'updatePeriodicMessage': {
      const pl = data.payload
      const buf = Buffer.isBuffer(pl) ? pl : Buffer.from((pl as any)?.data ?? pl ?? [])
      instance?.updatePeriodicMessage(
        String(data.taskId),
        data.msg,
        buf,
        Boolean(data.asNotify),
        Boolean(data.force)
      )
      break
    }
    case 'stopPeriodicMessage': {
      instance?.sendc.stop_periodic_message(String(data.taskId))
      break
    }
    case 'offerServices': {
      for (const e of data.services) {
        console.error(
          `[DEBUG-geea-someip-r42-offer-before] mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${e.service} instance=${e.instance} major=${e.major ?? 0} minor=${e.minor ?? 0}`
        )
        // The Windows routing path does not reliably dispatch external
        // provider requests through the all-wildcard handler. Register the
        // configured service/instance explicitly while retaining ANY_METHOD.
        instance?.registerServiceMessageHandler(Number(e.service), Number(e.instance))
        instance?.app.offer_service(
          Number(e.service),
          Number(e.instance),
          Number(e.major ?? 0),
          Number(e.minor ?? 0)
        )
        console.error(
          `[DEBUG-geea-someip-r42-offer-after] mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${e.service} instance=${e.instance}`
        )
      }
      break
    }
    case 'stopOfferServices': {
      for (const e of data.services) {
        console.error(
          `[DEBUG-geea-someip-r42-stop-offer-before] mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${e.service} instance=${e.instance}`
        )
        instance?.app.stop_offer_service(Number(e.service), Number(e.instance))
        console.error(
          `[DEBUG-geea-someip-r42-stop-offer-after] mono_us=${(process.hrtime.bigint() / 1000n).toString()} service=${e.service} instance=${e.instance}`
        )
      }
      break
    }
    case 'releaseServices': {
      for (const e of data.services) {
        instance?.app.release_service(Number(e.service), Number(e.instance))
      }
      break
    }
    case 'requestEvent': {
      // SWIG N-API exposes C++ method names (snake_case), not camelCase
      instance?.sendc.request_event_one_group(
        Number(data.service),
        Number(data.instance),
        Number(data.event),
        Number(data.eventgroup),
        Number(data.eventType ?? 2)
      )
      break
    }
    case 'releaseEvent': {
      instance?.sendc.release_event_simple(
        Number(data.service),
        Number(data.instance),
        Number(data.event)
      )
      break
    }
    case 'offerEvent': {
      const eventgroups = Array.isArray(data.eventgroups)
        ? data.eventgroups.map((v: unknown) => Number(v))
        : data.eventgroup !== undefined && data.eventgroup !== null
          ? [Number(data.eventgroup)]
          : []
      if (eventgroups.length === 0) {
        throw new Error('offerEvent requires eventgroup or eventgroups')
      }
      // SWIG expects std::set<eventgroup_t>*; use Send helper (same pattern as request_event_one_group)
      instance?.sendc.offer_event_with_groups(
        Number(data.service),
        Number(data.instance),
        Number(data.event),
        eventgroups.join(','),
        Number(data.eventType ?? 0)
      )
      break
    }
    case 'registerSubscriptionHandler': {
      instance?.registerSubscriptionHandler(
        Number(data.service),
        Number(data.instance),
        Number(data.eventgroup)
      )
      break
    }
    case 'stopOfferEvent': {
      instance?.app.stop_offer_event(
        Number(data.service),
        Number(data.instance),
        Number(data.event)
      )
      break
    }
    case 'subscribe': {
      instance?.app.subscribe(
        Number(data.service),
        Number(data.instance),
        Number(data.eventgroup),
        Number(data.major ?? 0),
        Number(data.event)
      )
      break
    }
    case 'unsubscribe': {
      const s = Number(data.service)
      const i = Number(data.instance)
      const eg = Number(data.eventgroup)
      if (data.event !== undefined && data.event !== null && data.event !== '') {
        instance?.app.unsubscribe(s, i, eg, Number(data.event))
      } else {
        instance?.app.unsubscribe(s, i, eg)
      }
      break
    }
  }

  process.send!(response)
})
